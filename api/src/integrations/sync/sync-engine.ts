import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ActivitySource,
  ExternalGroupMapping,
  IntegrationConnection,
  IntegrationStatus,
  LifecycleState,
  Prisma,
  UserRoleSource,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../../activity/activity.service';
import { AdministrabilityService } from '../../access/administrability.service';
import { ConflictError } from '../../common/errors';
import { EventStore } from '../../events/event-store.service';
import { TokenVault } from '../token-vault';
import { mappingTarget } from './mapping-target';
import {
  INTEGRATION_SYNC_PORT,
  type ExternalGroupId,
  type ExternalRoleOp,
  type ExternalUserId,
  type IntegrationSyncPort,
  type OutboundFailReason,
} from './integration-sync.port';
import { UnitDefaultsService } from '../../membership/unit-defaults.service';
import {
  BaselineEdge,
  Holding,
  LinkedUser,
  PatriceOp,
  ReconcileOutput,
  SyncMapping,
  SyncTarget,
  holdingKey,
  reconcile,
  targetKey,
} from './reconciler';

type ConnectionWithMappings = IntegrationConnection & { groupMappings: ExternalGroupMapping[] };

const toSyncMapping = (m: ExternalGroupMapping): SyncMapping => ({
  id: m.id,
  target: mappingTarget(m),
  externalGroupId: m.externalGroupId,
  syncDirection: m.syncDirection,
  conflictWinner: m.conflictWinner,
  isBroken: m.isBroken,
});

const opKey = (op: ExternalRoleOp) => `${op.externalUserId}:${op.externalGroupId}:${op.action}`;

/**
 * Applies a reconcile to both sides, for any provider behind the sync port.
 *
 * Order matters (problems D9, D26): outbound pushes go first; then, **per user, in
 * one transaction**, the Patrice-side grants and revokes and the baseline edges whose
 * changes actually happened. A failed push leaves its edge's baseline as it was, so
 * the next run retries it rather than misreading it as a provider change. Role
 * changes run under the admin floor. Any failure resets `sync_state` and rethrows, so
 * the job retries and the connection never sticks at "running".
 */
@Injectable()
export class SyncEngine {
  private readonly logger = new Logger(SyncEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly admin: AdministrabilityService,
    private readonly events: EventStore,
    @Inject(INTEGRATION_SYNC_PORT) private readonly port: IntegrationSyncPort,
    private readonly defaults: UnitDefaultsService,
  ) {}

  /** Reconcile a whole connection. */
  async sync(connectionId: string): Promise<void> {
    const conn = await this.loadConnection(connectionId);
    if (!conn) return;
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { syncState: 'running', lastSyncStartedAt: new Date() },
    });
    await this.log(conn.id, 'integration.sync_started', { connectionId });
    try {
      const membership = await this.port.fetchMembership(conn);
      const groups = await this.port.fetchGroups(conn);
      const bidirectional = conn.groupMappings.some((m) => m.syncDirection === 'bidirectional');
      const changedAt = bidirectional ? await this.port.fetchRecentGroupChanges(conn) : new Map<string, Date>();
      const links = await this.prisma.externalIdentity.findMany({
        where: { connectionId },
        select: { userId: true, externalUserId: true },
      });
      const result = reconcile({
        ...(await this.loadPatriceState(conn, links)),
        externalMembership: membership,
        knownGroupIds: new Set(groups.map((g) => g.id)),
        externalChangedAt: changedAt,
      });
      const outcome = await this.apply(conn, result);
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: {
          status: outcome.credentialsRejected ? IntegrationStatus.broken : IntegrationStatus.active,
          syncState: 'idle',
          lastSyncAt: new Date(),
          lastSyncGranted: outcome.granted,
          lastSyncRevoked: outcome.revoked,
          lastError: outcome.outboundError ?? null,
        },
      });
      await this.log(conn.id, 'integration.synced', {
        connectionId,
        grantedCount: outcome.granted,
        revokedCount: outcome.revoked,
      });
      await this.prisma.externalIdentity.updateMany({ where: { connectionId }, data: { lastSyncedAt: new Date() } });
    } catch (err) {
      await this.fail(connectionId, err as Error);
      throw err;
    }
  }

  /** Reconcile one member (the Gateway doorbell path). */
  async syncUser(connectionId: string, externalUserId: ExternalUserId): Promise<void> {
    const conn = await this.loadConnection(connectionId);
    if (!conn) return;
    const link = await this.prisma.externalIdentity.findUnique({
      where: { connectionId_externalUserId: { connectionId, externalUserId } },
      select: { id: true, userId: true, externalUserId: true },
    });
    if (!link) return; // a member with no Patrice account
    try {
      const groups = await this.port.fetchMember(conn, externalUserId);
      const result = reconcile({
        ...(await this.loadPatriceState(conn, [link])),
        externalMembership: new Map([[externalUserId, groups]]),
        // A single member says nothing about deleted groups: leave that to the sweep.
        knownGroupIds: new Set(conn.groupMappings.map((m) => m.externalGroupId)),
      });
      const outcome = await this.apply(conn, result);
      await this.prisma.externalIdentity.update({ where: { id: link.id }, data: { lastSyncedAt: new Date() } });
      if (outcome.outboundError) {
        await this.prisma.integrationConnection.update({
          where: { id: connectionId },
          data: {
            lastError: outcome.outboundError,
            ...(outcome.credentialsRejected ? { status: IntegrationStatus.broken } : {}),
          },
        });
      }
    } catch (err) {
      await this.fail(connectionId, err as Error);
      throw err;
    }
  }

  // ---- Loading -------------------------------------------------------------------

  /** An active connection with a stored token, or null (marking it broken if no token). */
  private async loadConnection(connectionId: string): Promise<ConnectionWithMappings | null> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      include: { groupMappings: true },
    });
    if (!conn || conn.lifecycleState === LifecycleState.retired) return null;
    if (!TokenVault.isHandle(conn.credentialsRef)) {
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: IntegrationStatus.broken, syncState: 'idle', lastError: 'No bot token is stored. Rotate the token.' },
      });
      return null;
    }
    return conn;
  }

  private async loadPatriceState(conn: ConnectionWithMappings, links: LinkedUser[]) {
    const mappings = conn.groupMappings.map(toSyncMapping);
    const userIds = links.map((l) => l.userId);
    const ids = (kind: SyncTarget['kind']) => [
      ...new Set(mappings.filter((m) => m.target.kind === kind).map((m) => m.target.id)),
    ];
    const [roleIds, divisionIds, teamIds] = [ids('role'), ids('division'), ids('team')];

    const [userRoles, memberships, roles, divisions, teams] = await Promise.all([
      this.prisma.userRole.findMany({ where: { userId: { in: userIds }, roleId: { in: roleIds } } }),
      this.prisma.membership.findMany({
        where: { userId: { in: userIds }, OR: [{ divisionId: { in: divisionIds } }, { teamId: { in: teamIds } }] },
      }),
      this.prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, lifecycleState: true } }),
      this.prisma.division.findMany({ where: { id: { in: divisionIds } }, select: { id: true, lifecycleState: true } }),
      this.prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, lifecycleState: true } }),
    ]);

    const holdings = new Map<string, Holding>();
    const sourceOf = (s: UserRoleSource): Holding['source'] => (s === UserRoleSource.integration ? 'integration' : 'patrice');
    for (const ur of userRoles) {
      holdings.set(holdingKey(ur.userId, { kind: 'role', id: ur.roleId }), { source: sourceOf(ur.source), since: ur.grantedAt });
    }
    for (const m of memberships) {
      const target: SyncTarget = m.divisionId ? { kind: 'division', id: m.divisionId } : { kind: 'team', id: m.teamId! };
      holdings.set(holdingKey(m.userId, target), { source: sourceOf(m.source), since: m.createdAt });
    }

    const inactiveTargets = new Set<string>();
    const present = new Set<string>();
    for (const [kind, rows] of [['role', roles], ['division', divisions], ['team', teams]] as const) {
      for (const r of rows) {
        present.add(targetKey({ kind, id: r.id }));
        if (r.lifecycleState === LifecycleState.retired) inactiveTargets.add(targetKey({ kind, id: r.id }));
      }
    }
    for (const m of mappings) if (!present.has(targetKey(m.target))) inactiveTargets.add(targetKey(m.target));

    const bidirectional = mappings.filter((m) => m.syncDirection === 'bidirectional').map((m) => m.id);
    let baseline: Set<string> | undefined;
    if (bidirectional.length > 0) {
      const rows = await this.prisma.syncBaseline.findMany({
        where: {
          connectionId: conn.id,
          mappingId: { in: bidirectional },
          externalUserId: { in: links.map((l) => l.externalUserId) },
        },
        select: { externalUserId: true, externalGroupId: true },
      });
      baseline = new Set(rows.map((r) => `${r.externalUserId}:${r.externalGroupId}`));
    }
    return { mappings, linkedUsers: links, holdings, inactiveTargets, baseline };
  }

  // ---- Applying ------------------------------------------------------------------

  private async apply(
    conn: ConnectionWithMappings,
    result: ReconcileOutput,
  ): Promise<{ granted: number; revoked: number; outboundError?: string; credentialsRejected?: boolean }> {
    for (const mappingId of result.brokenMappingIds) {
      const m = conn.groupMappings.find((x) => x.id === mappingId)!;
      await this.prisma.externalGroupMapping.update({ where: { id: mappingId }, data: { isBroken: true } });
      await this.log(conn.id, 'integration.broken', { connectionId: conn.id, externalGroupId: m.externalGroupId }, 'external_group_mapping', mappingId);
    }

    // 1. Outbound first: only pushes that succeed may move the baseline.
    const pushed = new Set<string>();
    let outboundError: string | undefined;
    let credentialsRejected = false;
    if (result.externalOps.length > 0) {
      const applied = await this.port.applyOutbound(conn, result.externalOps);
      outboundError = applied.lastError;
      credentialsRejected = applied.credentialsRejected ?? false;
      for (const op of applied.appliedOps) pushed.add(opKey(op));
      await this.logPushes(conn, result, applied.appliedOps);
      if (credentialsRejected) {
        await this.log(conn.id, 'integration.token_invalid', { connectionId: conn.id });
      }
      if (applied.brokenGroupIds.length > 0) {
        await this.markPushFailures(conn, applied.brokenGroupIds, applied.failReason ?? 'other');
      }
    }

    // 2. Per user, one transaction: Patrice-side changes and the settled baseline.
    const users = new Set([...result.patriceOps.map((o) => o.userId), ...result.baselineEdges.map((e) => e.userId)]);
    let granted = 0;
    let revoked = 0;
    for (const userId of users) {
      const ops = result.patriceOps.filter((o) => o.userId === userId);
      const edges = result.baselineEdges.filter(
        (e) => e.userId === userId && (!e.dependsOn || pushed.has(opKey(e.dependsOn))),
      );
      const done = await this.applyForUser(conn.id, userId, ops, edges);
      if (!done) continue;
      granted += ops.filter((o) => o.kind === 'grant').length;
      revoked += ops.filter((o) => o.kind === 'revoke').length;
    }
    return { granted, revoked, outboundError, credentialsRejected };
  }

  /** One user's changes in one transaction. False when the admin floor refused them. */
  private async applyForUser(
    connectionId: string,
    userId: string,
    ops: PatriceOp[],
    edges: BaselineEdge[],
  ): Promise<boolean> {
    const mutate = async (tx: Prisma.TransactionClient) => {
      for (const op of ops) await this.applyOp(tx, connectionId, op);
      for (const e of edges) {
        const where = {
          connectionId,
          mappingId: e.mappingId,
          externalUserId: e.externalUserId,
          externalGroupId: e.externalGroupId,
        };
        if (e.present) {
          await tx.syncBaseline.upsert({
            where: { connectionId_mappingId_externalUserId_externalGroupId: where },
            create: where,
            update: { updatedAt: new Date() },
          });
        } else {
          await tx.syncBaseline.deleteMany({ where });
        }
      }
    };
    if (!ops.some((o) => o.target.kind === 'role')) {
      await this.prisma.$transaction(mutate);
      return true;
    }
    try {
      await this.admin.withAdminFloor(null, { type: 'user', id: userId, path: 'integration.sync' }, mutate);
      return true;
    } catch (e) {
      if (e instanceof ConflictError) {
        this.logger.warn(`Sync changes for user ${userId} refused: they would remove the last administrator`);
        return false;
      }
      throw e;
    }
  }

  private async applyOp(tx: Prisma.TransactionClient, connectionId: string, op: PatriceOp): Promise<void> {
    const source = { source: ActivitySource.integration, sourceConnectionId: connectionId };
    if (op.target.kind === 'role') {
      const roleId = op.target.id;
      if (op.kind === 'grant') {
        await tx.userRole.create({
          data: { userId: op.userId, roleId, source: UserRoleSource.integration, sourceConnectionId: connectionId },
        });
        await this.activity.logActivity({
          tx, actorUserId: null, subjectType: 'user_role', subjectId: op.userId,
          verb: 'user_role.granted', payload: { userId: op.userId, roleId }, ...source,
        });
      } else {
        await tx.userRole.delete({ where: { userId_roleId: { userId: op.userId, roleId } } });
        await this.activity.logActivity({
          tx, actorUserId: null, subjectType: 'user_role', subjectId: op.userId,
          verb: 'integration.removed', payload: { connectionId, userId: op.userId, roleId }, ...source,
        });
      }
      return;
    }
    const unit = op.target.kind === 'division' ? { divisionId: op.target.id } : { teamId: op.target.id };
    const ref = { kind: op.target.kind, id: op.target.id } as const;
    if (op.kind === 'grant') {
      await tx.membership.create({
        data: { userId: op.userId, ...unit, source: UserRoleSource.integration, sourceConnectionId: connectionId },
      });
      await this.defaults.joined(tx, op.userId, ref, null);
    } else {
      const { count } = await tx.membership.deleteMany({
        where: { userId: op.userId, ...unit, source: UserRoleSource.integration },
      });
      if (count > 0) await this.defaults.left(tx, op.userId, ref, null);
    }
    await this.activity.logActivity({
      tx, actorUserId: null, subjectType: 'membership', subjectId: op.userId,
      verb: op.kind === 'grant' ? 'membership.added' : 'membership.removed',
      payload: { userId: op.userId, unitType: op.target.kind, unitId: op.target.id },
      ...source,
    });
  }

  /** One audit row per (user, target) pushed to the provider. */
  private async logPushes(conn: ConnectionWithMappings, result: ReconcileOutput, appliedOps: ExternalRoleOp[]) {
    const userByExternal = new Map(result.baselineEdges.map((e) => [e.externalUserId, e.userId]));
    const links = await this.prisma.externalIdentity.findMany({
      where: { connectionId: conn.id, externalUserId: { in: appliedOps.map((o) => o.externalUserId) } },
      select: { userId: true, externalUserId: true },
    });
    for (const l of links) userByExternal.set(l.externalUserId, l.userId);
    for (const op of appliedOps) {
      const userId = userByExternal.get(op.externalUserId);
      const mapping = conn.groupMappings.find((m) => m.externalGroupId === op.externalGroupId);
      if (!userId || !mapping) continue;
      const target = mappingTarget(mapping);
      await this.log(
        conn.id,
        op.action === 'add' ? 'integration.external_role_added' : 'integration.external_role_removed',
        { connectionId: conn.id, userId, targetKind: target.kind, targetId: target.id, externalGroupId: op.externalGroupId },
        'user_role',
        userId,
      );
    }
  }

  /** Flag mappings whose pushes failed permanently, and alert the admins once. */
  private async markPushFailures(conn: ConnectionWithMappings, groupIds: ExternalGroupId[], reason: OutboundFailReason) {
    for (const gid of groupIds) {
      for (const m of conn.groupMappings.filter((x) => x.externalGroupId === gid && !x.isBroken)) {
        await this.prisma.externalGroupMapping.update({ where: { id: m.id }, data: { isBroken: true } });
        await this.log(
          conn.id,
          'integration.push_failed',
          { connectionId: conn.id, roleId: m.roleId, externalGroupId: gid, reason },
          'external_group_mapping',
          m.id,
        );
      }
    }
    const adminIds = await this.admin.effectiveAdminIds();
    if (adminIds.length === 0) return;
    await this.prisma.$transaction((tx) =>
      this.events.record(tx, {
        type: 'integration.push_failed',
        actorUserId: null,
        payload: { connectionId: conn.id, reason },
        notify: { type: 'integration.push_failed', recipients: adminIds },
      }),
    );
    await this.events.deliver();
  }

  private async fail(connectionId: string, err: Error): Promise<void> {
    this.logger.error(`Sync failed for ${connectionId}: ${err.message}`);
    await this.prisma.integrationConnection
      .update({
        where: { id: connectionId },
        data: { syncState: 'idle', lastError: `Sync failed: ${err.message}`.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  private log(
    connectionId: string,
    verb: Parameters<ActivityService['logActivity']>[0]['verb'],
    payload: object,
    subjectType = 'integration_connection',
    subjectId = connectionId,
  ) {
    return this.activity.logActivity({
      actorUserId: null,
      subjectType,
      subjectId,
      verb,
      payload,
      source: ActivitySource.integration,
      sourceConnectionId: connectionId,
    } as Parameters<ActivityService['logActivity']>[0]);
  }
}
