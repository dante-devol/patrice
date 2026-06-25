import { Inject, Injectable, Logger } from '@nestjs/common';
import { ActivitySource, IntegrationStatus, LifecycleState, UserRoleSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../../activity/activity.service';
import { ENV, Env } from '../../config/env';
import type {
  IntegrationSyncPort,
  ExternalUserId,
  ExternalGroupId,
  ExternalGroup,
  ExternalRoleOp,
  ApplyResult,
} from './integration-sync.port';
import { reconcile } from './reconciler';
import type { IntegrationConnection } from '@prisma/client';
import { SECRET_CIPHER_PORT, type SecretCipherPort } from '../secret-cipher.port';
import { DiscordRestClient } from './discord-rest.client';

interface DiscordGuildMember {
  user: { id: string };
  roles: string[];
}

/**
 * Discord sync adapter (Slice 8.4 / #56).
 *
 * Provider I/O only — reconciliation logic lives in reconciler.ts.
 * Runs only from pg-boss jobs, never inline.
 */
@Injectable()
export class DiscordAdapter implements IntegrationSyncPort {
  readonly provider = 'discord';
  private readonly logger = new Logger(DiscordAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SECRET_CIPHER_PORT) private readonly cipher: SecretCipherPort,
    private readonly rest: DiscordRestClient,
  ) {}

  // ---------------------------------------------------------------------------
  // IntegrationSyncPort implementation
  // ---------------------------------------------------------------------------

  async fetchMembership(conn: IntegrationConnection): Promise<Map<ExternalUserId, ExternalGroupId[]>> {
    const botToken = await this.resolveBotToken(conn);
    const members = await this.fetchGuildMembers(conn.externalWorkspaceId, botToken);
    const result = new Map<ExternalUserId, ExternalGroupId[]>();
    for (const m of members) {
      result.set(m.user.id, m.roles);
    }
    return result;
  }

  async fetchGroups(conn: IntegrationConnection): Promise<ExternalGroup[]> {
    const botToken = await this.resolveBotToken(conn);
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${conn.externalWorkspaceId}/roles`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Discord roles fetch error ${res.status}: ${await res.text()}`);
    }
    const roles = (await res.json()) as { id: string; name: string }[];
    return roles.map((r) => ({ id: r.id, name: r.name }));
  }

  /**
   * Apply outbound role ops to Discord. One PUT/DELETE per (member, role) delta.
   *
   * Failure taxonomy:
   *  - 429 / 5xx / network: transient — DiscordRestClient retries; never sets is_broken.
   *  - 403 hierarchy/permission, 404 role/guild gone: permanent — mark broken.
   *  - 401 invalid token: connection broken with reason.
   *  - Partial progress: collect per-op outcomes, continue.
   */
  async applyOutbound(conn: IntegrationConnection, ops: ExternalRoleOp[]): Promise<ApplyResult> {
    const botToken = await this.resolveBotToken(conn);
    const guildId = conn.externalWorkspaceId;
    let applied = 0;
    let failed = 0;
    const brokenGroupIds: ExternalGroupId[] = [];

    for (const op of ops) {
      try {
        const result = op.action === 'add'
          ? await this.rest.addMemberRole(guildId, op.externalUserId, op.externalGroupId, botToken)
          : await this.rest.removeMemberRole(guildId, op.externalUserId, op.externalGroupId, botToken);

        if (result.ok || result.status === 204) {
          applied++;
        } else if (result.status === 401) {
          // Invalid token — mark the whole connection broken and abort.
          await this.prisma.integrationConnection.update({
            where: { id: conn.id },
            data: { status: IntegrationStatus.broken },
          });
          this.logger.error(`Discord 401 on connection ${conn.id}: token may be invalid`);
          return { applied, failed: ops.length - applied, brokenGroupIds };
        } else if (result.status === 403 || result.status === 404) {
          // Hierarchy violation or role/guild gone — mark the external group broken.
          if (!brokenGroupIds.includes(op.externalGroupId)) {
            brokenGroupIds.push(op.externalGroupId);
          }
          failed++;
        } else {
          failed++;
          this.logger.warn(`Outbound op ${op.action} ${op.externalGroupId} → ${op.externalUserId} status ${result.status}`);
        }
      } catch (err) {
        failed++;
        this.logger.error(`Outbound op failed: ${(err as Error).message}`);
      }
    }

    return { applied, failed, brokenGroupIds };
  }

  // ---------------------------------------------------------------------------
  // Top-level sync entry point (called by SyncService)
  // ---------------------------------------------------------------------------

  async sync(connectionId: string): Promise<void> {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      include: { groupMappings: true },
    });
    if (!connection || connection.lifecycleState === LifecycleState.retired) {
      this.logger.warn(`Sync skipped: connection ${connectionId} not found or retired`);
      return;
    }

    const botToken = await this.resolveBotToken(connection);
    if (!botToken) {
      this.logger.warn(`Sync skipped: no botToken in connection ${connectionId}`);
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: IntegrationStatus.broken },
      });
      return;
    }

    // --- Fetch external state ---
    let externalMembership: Map<ExternalUserId, ExternalGroupId[]>;
    let knownGroupIds: Set<ExternalGroupId>;
    try {
      externalMembership = await this.fetchMembership(connection);
      const groups = await this.fetchGroups(connection);
      knownGroupIds = new Set(groups.map((g) => g.id));
    } catch (err) {
      this.logger.error(`Discord fetch failed for ${connectionId}: ${(err as Error).message}`);
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: IntegrationStatus.broken },
      });
      return;
    }

    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { status: IntegrationStatus.active },
    });

    // --- Batch-load Patrice state (no N+1) ---
    const linkedUsers = await this.prisma.externalIdentity.findMany({
      where: { connectionId },
      select: { userId: true, externalUserId: true },
    });

    const linkedUserIds = linkedUsers.map((l) => l.userId);
    const mappedRoleIds = [...new Set(connection.groupMappings.map((m) => m.roleId))];

    const [existingRoleRows, roleRows] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: { in: linkedUserIds }, roleId: { in: mappedRoleIds } },
      }),
      this.prisma.role.findMany({ where: { id: { in: mappedRoleIds } } }),
    ]);

    const existingRoles = new Map(existingRoleRows.map((ur) => [`${ur.userId}:${ur.roleId}`, ur]));
    const roleMap = new Map(roleRows.map((r) => [r.id, r]));

    const activeMappings = connection.groupMappings.filter((m) => !m.isBroken);

    const { paOps, externalOps, brokenMappingIds } = reconcile({
      mappings: activeMappings,
      linkedUsers,
      externalMembership,
      knownGroupIds,
      existingRoles,
      roleRows: roleMap,
    });

    // Use connection.organizationId directly — no extra DB round-trip.
    const orgId = connection.organizationId;

    // --- Apply broken-mapping flags ---
    for (const mappingId of brokenMappingIds) {
      const mapping = connection.groupMappings.find((m) => m.id === mappingId);
      await this.prisma.externalGroupMapping.update({
        where: { id: mappingId },
        data: { isBroken: true },
      });
      await this.activity.logActivity({
        organizationId: orgId,
        actorUserId: null,
        subjectType: 'external_group_mapping',
        subjectId: mappingId,
        verb: 'integration.broken',
        payload: { connectionId, externalGroupId: mapping?.externalGroupId ?? '' },
        source: ActivitySource.integration,
        sourceConnectionId: connectionId,
      });
    }

    // --- Apply Patrice-side ops ---
    let totalGranted = 0;
    let totalRevoked = 0;

    for (const op of paOps) {
      if (op.kind === 'grant') {
        await this.prisma.userRole.create({
          data: {
            userId: op.userId,
            roleId: op.roleId,
            source: UserRoleSource.integration,
            sourceConnectionId: connectionId,
          },
        });
        await this.activity.logActivity({
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'user_role',
          subjectId: op.userId,
          verb: 'user_role.granted',
          payload: { userId: op.userId, roleId: op.roleId },
          source: ActivitySource.integration,
          sourceConnectionId: connectionId,
        });
        totalGranted++;
      } else {
        await this.prisma.userRole.delete({
          where: { userId_roleId: { userId: op.userId, roleId: op.roleId } },
        });
        await this.activity.logActivity({
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'user_role',
          subjectId: op.userId,
          verb: 'integration.removed',
          payload: { connectionId, userId: op.userId, roleId: op.roleId },
          source: ActivitySource.integration,
          sourceConnectionId: connectionId,
        });
        totalRevoked++;
      }
    }

    // --- Apply external-side ops (outbound) ---
    if (externalOps.length > 0) {
      const applyResult = await this.applyOutbound(connection, externalOps);
      // Mark mappings broken for permanent failures (403/404 from Discord).
      for (const brokenGroupId of applyResult.brokenGroupIds) {
        const affectedMappings = connection.groupMappings.filter(
          (m) => m.externalGroupId === brokenGroupId && !m.isBroken,
        );
        for (const m of affectedMappings) {
          await this.prisma.externalGroupMapping.update({
            where: { id: m.id },
            data: { isBroken: true },
          });
          await this.activity.logActivity({
            organizationId: orgId,
            actorUserId: null,
            subjectType: 'external_group_mapping',
            subjectId: m.id,
            verb: 'integration.broken',
            payload: { connectionId, externalGroupId: brokenGroupId },
            source: ActivitySource.integration,
            sourceConnectionId: connectionId,
          });
        }
      }
    }

    await this.activity.logActivity({
      organizationId: orgId,
      actorUserId: null,
      subjectType: 'integration_connection',
      subjectId: connectionId,
      verb: 'integration.synced',
      payload: { connectionId, grantedCount: totalGranted, revokedCount: totalRevoked },
      source: ActivitySource.integration,
      sourceConnectionId: connectionId,
    });

    await this.prisma.externalIdentity.updateMany({
      where: { connectionId },
      data: { lastSyncedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async resolveBotToken(conn: IntegrationConnection): Promise<string> {
    if (conn.credentialsRef && this.cipher.canHandle(conn.credentialsRef)) {
      return this.cipher.decrypt(conn.credentialsRef);
    }
    // Backwards-compat: plaintext config.botToken until all connections migrated (#57).
    return (conn.config as Record<string, string>)['botToken'] ?? '';
  }

  private async fetchGuildMembers(guildId: string, botToken: string): Promise<DiscordGuildMember[]> {
    const members: DiscordGuildMember[] = [];
    let after = '0';

    while (true) {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
        { headers: { Authorization: `Bot ${botToken}` } },
      );
      if (!res.ok) {
        throw new Error(`Discord API error ${res.status}: ${await res.text()}`);
      }
      const page = (await res.json()) as DiscordGuildMember[];
      if (page.length === 0) break;
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }
    return members;
  }
}
