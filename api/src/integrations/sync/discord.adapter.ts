import { Injectable, Logger } from '@nestjs/common';
import type { IntegrationConnection } from '@prisma/client';
import { TokenVault } from '../token-vault';
import { DiscordRestClient } from './discord-rest.client';
import type {
  ApplyResult,
  ExternalGroup,
  ExternalGroupId,
  ExternalRoleOp,
  ExternalUserId,
  IntegrationSyncPort,
  OutboundFailReason,
} from './integration-sync.port';

interface DiscordGuildMember {
  user: { id: string };
  roles: string[];
}

interface DiscordAuditLog {
  audit_log_entries: Array<{
    id: string;
    target_id: string | null;
    changes?: Array<{ key: string; new_value?: Array<{ id: string }> }>;
  }>;
}

/** Discord's `MEMBER_ROLE_UPDATE` audit-log action. */
const MEMBER_ROLE_UPDATE = 25;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** A snowflake's creation time. */
const snowflakeTime = (id: string): Date => new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS);

/**
 * Discord's side of the sync port: guild members, roles and role pushes over the
 * rate-limited REST client. I/O only — what to change is the reconciler's call and
 * applying it is the SyncEngine's. Worker only: it opens the bot token.
 */
@Injectable()
export class DiscordAdapter implements IntegrationSyncPort {
  readonly provider = 'discord';
  private readonly logger = new Logger(DiscordAdapter.name);

  constructor(
    private readonly vault: TokenVault,
    private readonly rest: DiscordRestClient,
  ) {}

  private token(conn: IntegrationConnection): string {
    if (!TokenVault.isHandle(conn.credentialsRef)) {
      throw new Error('No bot token is stored for this connection');
    }
    return this.vault.decrypt(conn.credentialsRef);
  }

  private async get<T>(conn: IntegrationConnection, path: string): Promise<{ status: number; body: T }> {
    const res = await this.rest.fetch({ method: 'GET', path, botToken: this.token(conn) });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Discord GET ${path.replace(/\d{17,19}/g, ':id')} failed (${res.status})`);
    }
    return { status: res.status, body: res.body as T };
  }

  async fetchMembership(conn: IntegrationConnection): Promise<Map<ExternalUserId, ExternalGroupId[]>> {
    const result = new Map<ExternalUserId, ExternalGroupId[]>();
    let after = '0';
    for (;;) {
      const { body: page } = await this.get<DiscordGuildMember[]>(
        conn,
        `/guilds/${conn.externalWorkspaceId}/members?limit=1000&after=${after}`,
      );
      for (const m of page) result.set(m.user.id, m.roles);
      if (page.length < 1000) return result;
      after = page[page.length - 1].user.id;
    }
  }

  async fetchMember(conn: IntegrationConnection, externalUserId: ExternalUserId): Promise<ExternalGroupId[]> {
    const { status, body } = await this.get<{ roles?: string[] }>(
      conn,
      `/guilds/${conn.externalWorkspaceId}/members/${externalUserId}`,
    );
    return status === 404 ? [] : (body.roles ?? []);
  }

  async fetchGroups(conn: IntegrationConnection): Promise<ExternalGroup[]> {
    const { body } = await this.get<{ id: string; name: string }[]>(conn, `/guilds/${conn.externalWorkspaceId}/roles`);
    return body.map((r) => ({ id: r.id, name: r.name }));
  }

  /**
   * Recent role changes from the guild audit log (needs View Audit Log). Without the
   * permission, or on any error, returns nothing and conflicts fall back to the
   * mapping's winner.
   */
  async fetchRecentGroupChanges(conn: IntegrationConnection): Promise<Map<string, Date>> {
    const changes = new Map<string, Date>();
    try {
      const res = await this.rest.fetch({
        method: 'GET',
        path: `/guilds/${conn.externalWorkspaceId}/audit-logs?action_type=${MEMBER_ROLE_UPDATE}&limit=100`,
        botToken: this.token(conn),
      });
      if (!res.ok) return changes;
      // Entries are newest first, so the first sighting of an edge is its latest change.
      for (const entry of (res.body as DiscordAuditLog).audit_log_entries ?? []) {
        if (!entry.target_id) continue;
        const at = snowflakeTime(entry.id);
        for (const change of entry.changes ?? []) {
          if (change.key !== '$add' && change.key !== '$remove') continue;
          for (const role of change.new_value ?? []) {
            const key = `${entry.target_id}:${role.id}`;
            if (!changes.has(key)) changes.set(key, at);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Audit log unavailable for ${conn.id}: ${(err as Error).message}`);
    }
    return changes;
  }

  /**
   * Push role adds and removes, one request per op, continuing past failures.
   * 403/404 mark the group broken; 401 stops and reports the token rejected; anything
   * else (after the client's retries) is a transient failure for the next sync.
   */
  async applyOutbound(conn: IntegrationConnection, ops: ExternalRoleOp[]): Promise<ApplyResult> {
    const token = this.token(conn);
    const guildId = conn.externalWorkspaceId;
    const appliedOps: ExternalRoleOp[] = [];
    const brokenGroupIds: ExternalGroupId[] = [];
    let failed = 0;
    let lastError: string | undefined;
    let failReason: OutboundFailReason | undefined;

    for (const op of ops) {
      try {
        const result =
          op.action === 'add'
            ? await this.rest.addMemberRole(guildId, op.externalUserId, op.externalGroupId, token)
            : await this.rest.removeMemberRole(guildId, op.externalUserId, op.externalGroupId, token);
        if (result.ok) {
          appliedOps.push(op);
        } else if (result.status === 401) {
          return {
            applied: appliedOps.length,
            failed: ops.length - appliedOps.length,
            appliedOps,
            brokenGroupIds,
            credentialsRejected: true,
            lastError: 'Discord rejected the bot token. Rotate it in the integration settings.',
          };
        } else if (result.status === 403 || result.status === 404) {
          failed++;
          if (!brokenGroupIds.includes(op.externalGroupId)) brokenGroupIds.push(op.externalGroupId);
          if (result.status === 403) {
            failReason = 'permission';
            lastError =
              "Patrice couldn't update roles on Discord. The bot needs the “Manage Roles” permission, and its own role must sit above the roles it manages in your server's role list. Fix that in Discord, then press Retry.";
          } else {
            failReason = 'not_found';
            lastError =
              "A mapped Discord role no longer exists, so Patrice couldn't update it. Re-point or remove that mapping in the integration settings, then press Retry.";
          }
          this.logger.warn(`Outbound ${op.action} ${op.externalGroupId}: ${result.status} (mapping flagged broken)`);
        } else {
          failed++;
          failReason = 'other';
          lastError = "Discord wouldn't apply a role change. Check the bot's permissions in your server, then press Retry.";
        }
      } catch (err) {
        failed++;
        failReason = 'other';
        lastError = "Patrice couldn't reach Discord to apply a role change. It will try again on the next sync.";
        this.logger.error(`Outbound op failed: ${(err as Error).message}`);
      }
    }
    return { applied: appliedOps.length, failed, appliedOps, brokenGroupIds, lastError, failReason };
  }
}
