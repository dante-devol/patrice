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
  OutboundFailReason,
} from './integration-sync.port';
import { reconcile, type SyncBaseline, type ReconcileOutput } from './reconciler';
import type { IntegrationConnection, ExternalGroupMapping } from '@prisma/client';

/** A connection with its mappings eager-loaded (the shape both sync paths use). */
type ConnectionWithMappings = IntegrationConnection & { groupMappings: ExternalGroupMapping[] };

/** A linked Discord account ↔ Patrice user pair. */
interface LinkPair {
  userId: string;
  externalUserId: ExternalUserId;
}
import { SECRET_CIPHER_PORT, type SecretCipherPort } from '../secret-cipher.port';
import { DiscordRestClient } from './discord-rest.client';
import { NotificationsService } from '../../notifications/notifications.service';
import { AdministrabilityService } from '../../access/administrability.service';

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
    private readonly notifications: NotificationsService,
    private readonly admin: AdministrabilityService,
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
    let failed = 0;
    let lastError: string | undefined;
    let failReason: OutboundFailReason | undefined;
    const appliedOps: ExternalRoleOp[] = [];
    const brokenGroupIds: ExternalGroupId[] = [];

    for (const op of ops) {
      try {
        const result = op.action === 'add'
          ? await this.rest.addMemberRole(guildId, op.externalUserId, op.externalGroupId, botToken)
          : await this.rest.removeMemberRole(guildId, op.externalUserId, op.externalGroupId, botToken);

        if (result.ok || result.status === 204) {
          appliedOps.push(op);
        } else if (result.status === 401) {
          // Invalid token — mark the whole connection broken and abort.
          await this.prisma.integrationConnection.update({
            where: { id: conn.id },
            data: {
              status: IntegrationStatus.broken,
              lastError: 'Discord rejected the bot token (401) — rotate it',
            },
          });
          await this.activity.logActivity({
            organizationId: conn.organizationId,
            actorUserId: null,
            subjectType: 'integration_connection',
            subjectId: conn.id,
            verb: 'integration.token_invalid',
            payload: { connectionId: conn.id },
            source: ActivitySource.integration,
            sourceConnectionId: conn.id,
          });
          this.logger.error(`Discord 401 on connection ${conn.id}: token may be invalid`);
          return { applied: appliedOps.length, failed: ops.length - appliedOps.length, appliedOps, brokenGroupIds };
        } else if (result.status === 403 || result.status === 404) {
          // Hierarchy violation or role/guild gone — mark the external group broken.
          if (!brokenGroupIds.includes(op.externalGroupId)) {
            brokenGroupIds.push(op.externalGroupId);
          }
          failed++;
          // Plain-language messages — admins aren't developers; no HTTP codes here.
          if (result.status === 403) {
            failReason = 'permission';
            lastError =
              "Patrice couldn't update roles on Discord. The bot needs the “Manage Roles” permission, and its own role must sit above the roles it manages in your server's role list. Fix that in Discord, then press Retry.";
          } else {
            failReason = 'not_found';
            lastError =
              "A mapped Discord role no longer exists, so Patrice couldn't update it. Re-point or remove that mapping in the integration settings, then press Retry.";
          }
          // The status code stays in the server log for developers, not the admin UI.
          this.logger.warn(`Outbound ${op.action} ${op.externalGroupId} → ${op.externalUserId}: ${result.status} (mapping flagged broken)`);
        } else {
          failed++;
          failReason = 'other';
          lastError =
            "Discord wouldn't apply a role change. Check the bot's permissions in your server, then press Retry.";
          this.logger.warn(`Outbound op ${op.action} ${op.externalGroupId} → ${op.externalUserId} status ${result.status}`);
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
        data: {
          status: IntegrationStatus.broken,
          syncState: 'idle',
          lastError: 'No bot token configured',
        },
      });
      return;
    }

    // Mark running so admins see an in-flight reconcile (cleared on success/failure).
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { syncState: 'running', lastSyncStartedAt: new Date() },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId: null,
      subjectType: 'integration_connection',
      subjectId: connectionId,
      verb: 'integration.sync_started',
      payload: { connectionId },
      source: ActivitySource.integration,
      sourceConnectionId: connectionId,
    });

    // --- Fetch external state ---
    let externalMembership: Map<ExternalUserId, ExternalGroupId[]>;
    let knownGroupIds: Set<ExternalGroupId>;
    try {
      externalMembership = await this.fetchMembership(connection);
      const groups = await this.fetchGroups(connection);
      knownGroupIds = new Set(groups.map((g) => g.id));
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Discord fetch failed for ${connectionId}: ${message}`);
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: IntegrationStatus.broken,
          syncState: 'idle',
          lastError: `Discord fetch failed: ${message}`.slice(0, 500),
        },
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
    const bidirectionalMappingIds = activeMappings
      .filter((m) => m.syncDirection === 'bidirectional')
      .map((m) => m.id);

    // Load sync baseline for bidirectional mappings (#59).
    let baseline: SyncBaseline | undefined;
    if (bidirectionalMappingIds.length > 0) {
      const rows = await this.prisma.syncBaseline.findMany({
        where: { connectionId, mappingId: { in: bidirectionalMappingIds } },
        select: { externalUserId: true, externalGroupId: true },
      });
      baseline = new Set(rows.map((r) => `${r.externalUserId}:${r.externalGroupId}`));
    }

    const result = reconcile({
      mappings: activeMappings,
      linkedUsers,
      externalMembership,
      knownGroupIds,
      existingRoles,
      roleRows: roleMap,
      baseline,
    });

    const { totalGranted, totalRevoked, outboundError } = await this.applyReconcileResult(
      connection,
      result,
      linkedUsers,
    );

    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: {
        syncState: 'idle',
        lastSyncAt: new Date(),
        lastSyncGranted: totalGranted,
        lastSyncRevoked: totalRevoked,
        // Surface an outbound failure (e.g. a 403 hierarchy refusal) instead of
        // silently clearing it — otherwise a push that Discord rejects is invisible.
        lastError: outboundError ?? null,
      },
    });

    await this.activity.logActivity({
      organizationId: connection.organizationId,
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
  // Targeted per-user reconcile (Doorbell fast path)
  // ---------------------------------------------------------------------------

  /**
   * Reconcile a **single** linked user's edges, triggered by a Gateway member event
   * for that user. Fetches just their member object instead of the whole guild, so
   * the blast radius (and REST cost) is one user, not the connection. Broken-mapping
   * detection + the connection-wide status/observability fields are left to the full
   * sweep — this path only grants/revokes/pushes for the one user and logs each as
   * its own activity row.
   */
  async syncUser(connectionId: string, externalUserId: ExternalUserId): Promise<void> {
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      include: { groupMappings: true },
    });
    if (!connection || connection.lifecycleState === LifecycleState.retired) return;

    const linked = await this.prisma.externalIdentity.findUnique({
      where: { connectionId_externalUserId: { connectionId, externalUserId } },
      select: { id: true, userId: true },
    });
    if (!linked) return; // a guild member with no Patrice account — nothing to reconcile

    const botToken = await this.resolveBotToken(connection);
    if (!botToken) return; // leave status flips to the full sweep

    let memberRoles: ExternalGroupId[];
    try {
      memberRoles = await this.fetchMember(connection.externalWorkspaceId, externalUserId, botToken);
    } catch (err) {
      // Transient — the Reconcile Floor sweep is the backstop.
      this.logger.warn(`Targeted member fetch failed for ${externalUserId}: ${(err as Error).message}`);
      return;
    }

    const linkedUsers: LinkPair[] = [{ userId: linked.userId, externalUserId }];
    const externalMembership = new Map<ExternalUserId, ExternalGroupId[]>([[externalUserId, memberRoles]]);
    const mappedRoleIds = [...new Set(connection.groupMappings.map((m) => m.roleId))];
    const activeMappings = connection.groupMappings.filter((m) => !m.isBroken);

    const [existingRoleRows, roleRows] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId: linked.userId, roleId: { in: mappedRoleIds } },
      }),
      this.prisma.role.findMany({ where: { id: { in: mappedRoleIds } } }),
    ]);
    const existingRoles = new Map(existingRoleRows.map((ur) => [`${ur.userId}:${ur.roleId}`, ur]));
    const roleMap = new Map(roleRows.map((r) => [r.id, r]));

    // Baseline for this user's bidirectional edges only.
    const bidirectionalMappingIds = activeMappings
      .filter((m) => m.syncDirection === 'bidirectional')
      .map((m) => m.id);
    let baseline: SyncBaseline | undefined;
    if (bidirectionalMappingIds.length > 0) {
      const rows = await this.prisma.syncBaseline.findMany({
        where: { connectionId, externalUserId, mappingId: { in: bidirectionalMappingIds } },
        select: { externalUserId: true, externalGroupId: true },
      });
      baseline = new Set(rows.map((r) => `${r.externalUserId}:${r.externalGroupId}`));
    }

    const result = reconcile({
      mappings: activeMappings,
      linkedUsers,
      externalMembership,
      // Pass all mapped groups as "known" so the single-member fetch can't be
      // mistaken for a deleted group — broken detection stays with the full sweep.
      knownGroupIds: new Set(activeMappings.map((m) => m.externalGroupId)),
      existingRoles,
      roleRows: roleMap,
      baseline,
    });

    const { outboundError } = await this.applyReconcileResult(connection, result, linkedUsers);
    await this.prisma.externalIdentity.update({
      where: { id: linked.id },
      data: { lastSyncedAt: new Date() },
    });
    // Surface an outbound refusal (e.g. 403 hierarchy) even on the targeted path —
    // don't clear an existing error here, just record a new one.
    if (outboundError) {
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { lastError: outboundError },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Shared apply (full sweep + targeted) — emits one activity row per role change
  // ---------------------------------------------------------------------------

  private async applyReconcileResult(
    connection: ConnectionWithMappings,
    result: ReconcileOutput,
    linkedUsers: LinkPair[],
  ): Promise<{ totalGranted: number; totalRevoked: number; outboundError?: string }> {
    const connectionId = connection.id;
    const orgId = connection.organizationId;
    let outboundError: string | undefined;
    const userIdByExternal = new Map(linkedUsers.map((l) => [l.externalUserId, l.userId]));
    const roleByGroup = new Map(connection.groupMappings.map((m) => [m.externalGroupId, m.roleId]));

    // --- Broken-mapping flags (empty on the targeted path) ---
    for (const mappingId of result.brokenMappingIds) {
      const mapping = connection.groupMappings.find((m) => m.id === mappingId);
      await this.prisma.externalGroupMapping.update({ where: { id: mappingId }, data: { isBroken: true } });
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

    // --- Patrice-side (inbound) ops — one row per (user, role) ---
    let totalGranted = 0;
    let totalRevoked = 0;
    for (const op of result.paOps) {
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

    // --- External-side (outbound) ops — one row per (user, role) pushed ---
    if (result.externalOps.length > 0) {
      const applyResult = await this.applyOutbound(connection, result.externalOps);
      outboundError = applyResult.lastError;

      for (const op of applyResult.appliedOps) {
        const userId = userIdByExternal.get(op.externalUserId);
        const roleId = roleByGroup.get(op.externalGroupId);
        if (!userId || !roleId) continue;
        await this.activity.logActivity({
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'user_role',
          subjectId: userId,
          verb: op.action === 'add' ? 'integration.external_role_added' : 'integration.external_role_removed',
          payload: { connectionId, userId, roleId, externalGroupId: op.externalGroupId },
          source: ActivitySource.integration,
          sourceConnectionId: connectionId,
        });
      }

      // Mark mappings broken for permanent failures + record a humanized audit row
      // per affected role (the UI turns `reason` into plain language).
      if (applyResult.brokenGroupIds.length > 0) {
        const reason: OutboundFailReason = applyResult.failReason ?? 'other';
        for (const brokenGroupId of applyResult.brokenGroupIds) {
          const affectedMappings = connection.groupMappings.filter(
            (m) => m.externalGroupId === brokenGroupId && !m.isBroken,
          );
          for (const m of affectedMappings) {
            await this.prisma.externalGroupMapping.update({ where: { id: m.id }, data: { isBroken: true } });
            await this.activity.logActivity({
              organizationId: orgId,
              actorUserId: null,
              subjectType: 'external_group_mapping',
              subjectId: m.id,
              verb: 'integration.push_failed',
              payload: { connectionId, roleId: m.roleId, externalGroupId: brokenGroupId, reason },
              source: ActivitySource.integration,
              sourceConnectionId: connectionId,
            });
          }
        }
        // One durable in-app alert to admins per failing sync. No SSE publish from the
        // worker (the api owns the stream); it surfaces on the admin's next reconcile.
        await this.alertAdminsOfPushFailure(connection, reason).catch((err) =>
          this.logger.warn(`admin push-failure alert failed: ${(err as Error).message}`),
        );
      }
    }

    // --- Sync baseline (#59) ---
    for (const u of result.baselineUpserts) {
      await this.prisma.syncBaseline.upsert({
        where: {
          connectionId_mappingId_externalUserId_externalGroupId: {
            connectionId,
            mappingId: u.mappingId,
            externalUserId: u.externalUserId,
            externalGroupId: u.externalGroupId,
          },
        },
        create: {
          connectionId,
          mappingId: u.mappingId,
          externalUserId: u.externalUserId,
          externalGroupId: u.externalGroupId,
        },
        update: { updatedAt: new Date() },
      });
    }
    if (result.baselineDeletes.length > 0) {
      await this.prisma.syncBaseline.deleteMany({
        where: {
          connectionId,
          OR: result.baselineDeletes.map((d) => ({
            mappingId: d.mappingId,
            externalUserId: d.externalUserId,
            externalGroupId: d.externalGroupId,
          })),
        },
      });
    }

    return { totalGranted, totalRevoked, outboundError };
  }

  /**
   * Durable in-app notification to the org's effective admins that an outbound push
   * was refused. Worker-safe: writes the rows but does **not** publish an SSE ping
   * (the api owns the stream; durability never rides it — the admin's next reconcile
   * picks it up). The bell humanizes `reason` — admins never see an HTTP status.
   */
  private async alertAdminsOfPushFailure(
    connection: ConnectionWithMappings,
    reason: OutboundFailReason,
  ): Promise<void> {
    const adminIds = await this.admin.effectiveAdminIds(connection.organizationId);
    if (adminIds.length === 0) return;
    await this.notifications.emit(this.prisma, {
      organizationId: connection.organizationId,
      type: 'integration.push_failed',
      subjectType: 'integration_connection',
      subjectId: connection.id,
      senderUserId: null,
      recipientUserIds: adminIds,
      payload: { connectionId: connection.id, reason },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Fetch one guild member's role ids. A 404 (left the guild) reads as no roles. */
  private async fetchMember(guildId: string, userId: string, botToken: string): Promise<ExternalGroupId[]> {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(`Discord member fetch error ${res.status}: ${await res.text()}`);
    }
    const member = (await res.json()) as { roles?: string[] };
    return member.roles ?? [];
  }

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
