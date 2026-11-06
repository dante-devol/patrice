import { Injectable } from '@nestjs/common';
import { GrantDisposition, LifecycleState, Prisma, UserRoleSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { AdministrabilityService } from '../access/administrability.service';
import { QueueService } from '../queue/queue.service';
import { GraceService } from '../common/grace.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { EFFECTIVE_ADMIN_ACTIONS } from '../access/actions';
import { DiscordLinkService } from './discord-link.service';
import { nextReconcileAt } from './reconcile-floor';
import { mappingTarget } from './sync/mapping-target';
import type { SyncTarget } from './sync/reconciler';
import type { StoreTokenJob } from './token.worker';
import {
  ConnectIntegrationDto,
  CreateMappingDto,
  DeleteMappingDto,
  RetireIntegrationDto,
  RotateTokenDto,
  UpdateIntegrationDto,
  UpdateMappingDto,
} from './integrations.dto';

/**
 * Strip secret-bearing fields from a connection row before it leaves the API.
 * Unconditional per ADR 0004 — no role or flag overrides this.
 */
export function toConnectionResponse<T extends { config: unknown; credentialsRef: unknown }>(
  conn: T,
): Omit<T, 'config' | 'credentialsRef'> {
  const { config: _c, credentialsRef: _r, ...rest } = conn;
  return rest;
}

const toMappingResponse = <T extends { roleId: string | null; divisionId: string | null; teamId: string | null }>(
  m: T,
  grantedCount: number,
) => ({ ...m, target: mappingTarget(m), grantedCount });

/**
 * The integration-granted roles and memberships a connection made: all of them, or
 * those of one target. A side that can't hold the target is null.
 */
function holdingWhere(connectionId: string, target: SyncTarget | null) {
  const base = { source: UserRoleSource.integration, sourceConnectionId: connectionId };
  const roles: Prisma.UserRoleWhereInput | null =
    !target || target.kind === 'role' ? { ...base, ...(target ? { roleId: target.id } : {}) } : null;
  const memberships: Prisma.MembershipWhereInput | null =
    !target
      ? base
      : target.kind === 'division'
        ? { ...base, divisionId: target.id }
        : target.kind === 'team'
          ? { ...base, teamId: target.id }
          : null;
  return { roles, memberships };
}

/**
 * Integration connections and their group mappings (admin side).
 *
 * The API never holds the bot-token key: a token received on connect or rotate goes
 * to the worker in an `integration.store-token` job. Connection changes signal the
 * worker's Gateway. When grants made by a mapping or a connection lose their source,
 * the admin decides: keep them as native grants (the default) or revoke them, under
 * the admin floor (intent-vs-reality §6.3).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
    private readonly queue: QueueService,
    private readonly admin: AdministrabilityService,
    private readonly links: DiscordLinkService,
  ) {}

  // ---- Connections -----------------------------------------------------------

  async list(includeRetired: boolean) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => ({
      ...toConnectionResponse(c),
      nextReconcileAt: c.lifecycleState === LifecycleState.active ? nextReconcileAt(c.lastSyncAt) : null,
    }));
  }

  /**
   * Connect a server. Reconnecting one whose connection is retired (not yet collected)
   * revives that connection instead of tripping the unique index (problems D27).
   * Everyone whose Discord id Patrice knows is linked to it straight away (D22).
   */
  async connect(actorUserId: string, dto: ConnectIntegrationDto) {
    const existing = await this.prisma.integrationConnection.findFirst({
      where: { provider: dto.provider, externalWorkspaceId: dto.externalWorkspaceId },
    });
    if (existing && existing.lifecycleState !== LifecycleState.retired) {
      throw new ConflictError('DUPLICATE_CONNECTION', 'A connection for this workspace already exists');
    }
    const connection = existing
      ? await this.prisma.integrationConnection.update({
          where: { id: existing.id },
          data: {
            displayName: dto.displayName,
            lifecycleState: LifecycleState.active,
            retiredAt: null,
            retireDisposition: null,
          },
        })
      : await this.prisma.integrationConnection.create({
          data: { provider: dto.provider, externalWorkspaceId: dto.externalWorkspaceId, displayName: dto.displayName },
        });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: connection.id,
      verb: existing ? 'integration.revived' : 'integration.connected',
      payload: { connectionId: connection.id },
    });
    await this.links.linkKnownMembers(connection.id);
    await this.handToWorker(connection.id, dto.botToken);
    return toConnectionResponse(await this.prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } }));
  }

  async update(id: string, actorUserId: string, dto: UpdateIntegrationDto) {
    await this.loadActive(id);
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}) },
    });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.updated',
      payload: { connectionId: id },
    });
    return toConnectionResponse(updated);
  }

  /** Replace the bot token. The worker encrypts it; the API never sees the key. */
  async rotateToken(id: string, actorUserId: string, dto: RotateTokenDto) {
    await this.loadActive(id);
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.token_rotated',
      payload: { connectionId: id },
    });
    await this.handToWorker(id, dto.botToken);
    return toConnectionResponse(await this.prisma.integrationConnection.findUniqueOrThrow({ where: { id } }));
  }

  /**
   * Retire a connection: sync pauses and the Gateway session closes. What happens to
   * the roles and memberships it granted is chosen now and applied when the
   * connection is collected after grace; revive cancels it.
   */
  async retire(id: string, actorUserId: string, dto: RetireIntegrationDto = {}) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    if (connection.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Integration connection is already retired');
    }
    const disposition = dto.grants ?? GrantDisposition.keep;
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { lifecycleState: LifecycleState.retired, retiredAt: new Date(), retireDisposition: disposition },
    });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.retired',
      payload: { connectionId: id, grants: disposition },
    });
    await this.signalGateway(id);
    return toConnectionResponse(updated);
  }

  async revive(id: string, actorUserId: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    if (!isRevivable(connection, await this.grace.windowMs())) {
      throw new ConflictError('NOT_REVIVABLE', 'Connection is not retired or its grace period has elapsed');
    }
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { lifecycleState: LifecycleState.active, retiredAt: null, retireDisposition: null },
    });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.revived',
      payload: { connectionId: id },
    });
    await this.signalGateway(id);
    return toConnectionResponse(updated);
  }

  // ---- Mappings --------------------------------------------------------------

  async listMappings(connectionId: string) {
    await this.loadActive(connectionId);
    const rows = await this.prisma.externalGroupMapping.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map(async (m) => toMappingResponse(m, await this.grantedCount(connectionId, mappingTarget(m)))));
  }

  async createMapping(connectionId: string, actorUserId: string, dto: CreateMappingDto) {
    await this.loadActive(connectionId);
    const target = await this.validTarget(dto);
    const duplicate = await this.prisma.externalGroupMapping.findFirst({
      where: { connectionId, externalGroupId: dto.externalGroupId, ...this.targetColumns(target) },
    });
    if (duplicate) throw new ConflictError('DUPLICATE_MAPPING', 'This mapping already exists');

    const mapping = await this.prisma.externalGroupMapping.create({
      data: {
        connectionId,
        externalGroupId: dto.externalGroupId,
        syncDirection: dto.syncDirection,
        ...this.targetColumns(target),
      },
    });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mapping.id,
      verb: 'external_group_mapping.created',
      payload: { mappingId: mapping.id, connectionId, targetKind: target.kind, targetId: target.id },
    });
    return toMappingResponse(mapping, 0);
  }

  async updateMapping(connectionId: string, mappingId: string, actorUserId: string, dto: UpdateMappingDto) {
    const mapping = await this.loadMapping(connectionId, mappingId);
    const updated = await this.prisma.externalGroupMapping.update({
      where: { id: mappingId },
      data: {
        ...(dto.syncDirection !== undefined && { syncDirection: dto.syncDirection }),
        ...(dto.conflictWinner !== undefined && { conflictWinner: dto.conflictWinner }),
        // Re-pointing at a new external group clears the broken flag for re-evaluation.
        ...(dto.externalGroupId !== undefined && { externalGroupId: dto.externalGroupId, isBroken: false }),
      },
    });
    const target = mappingTarget(mapping);
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'external_group_mapping.updated',
      payload: { mappingId, connectionId, targetKind: target.kind, targetId: target.id },
    });
    return toMappingResponse(updated, await this.grantedCount(connectionId, target));
  }

  /**
   * Delete a mapping. The roles or memberships it granted are kept as native grants
   * (the default) or revoked, as the admin chose after seeing `grantedCount`
   * (problems D23). They're left alone while another mapping on the connection
   * still grants the same thing.
   */
  async deleteMapping(connectionId: string, mappingId: string, actorUserId: string, dto: DeleteMappingDto = {}) {
    const mapping = await this.loadMapping(connectionId, mappingId);
    const target = mappingTarget(mapping);
    const disposition = dto.grants ?? GrantDisposition.keep;
    const stillMapped = await this.prisma.externalGroupMapping.count({
      where: { connectionId, id: { not: mappingId }, ...this.targetColumns(target) },
    });
    await this.prisma.externalGroupMapping.delete({ where: { id: mappingId } });
    const affected = stillMapped > 0 ? 0 : await this.releaseGrants(actorUserId, connectionId, target, disposition);
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'external_group_mapping.deleted',
      payload: { mappingId, connectionId, targetKind: target.kind, targetId: target.id, grants: disposition, affected },
    });
  }

  /** Record an admin-initiated reconcile in the audit log (the enqueue is the caller's). */
  async requestManualSync(id: string, actorUserId: string): Promise<void> {
    await this.loadActive(id);
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.reconcile_scheduled',
      payload: { connectionId: id, reason: 'manual' },
    });
  }

  /** Clear a mapping's broken flag so the next sync re-evaluates it (admin recovery). */
  async retryMapping(connectionId: string, mappingId: string, actorUserId: string) {
    const mapping = await this.loadMapping(connectionId, mappingId);
    const updated = await this.prisma.externalGroupMapping.update({ where: { id: mappingId }, data: { isBroken: false } });
    const target = mappingTarget(mapping);
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'integration.mapping_retried',
      payload: { mappingId, connectionId, targetKind: target.kind, targetId: target.id },
    });
    return toMappingResponse(updated, await this.grantedCount(connectionId, target));
  }

  // ---- Grants a connection made ----------------------------------------------

  /**
   * Keep (as native) or revoke the roles and memberships a connection granted — for
   * one target, or all of them. Revocations run under the admin floor. Returns how
   * many grants were affected.
   */
  async releaseGrants(
    actorUserId: string | null,
    connectionId: string,
    target: SyncTarget | null,
    disposition: GrantDisposition,
  ): Promise<number> {
    const where = holdingWhere(connectionId, target);
    const native = { source: UserRoleSource.patrice, sourceConnectionId: null };
    const run = async (tx: Prisma.TransactionClient) => {
      let affected = 0;
      if (where.roles) {
        affected += (
          disposition === GrantDisposition.keep
            ? await tx.userRole.updateMany({ where: where.roles, data: native })
            : await tx.userRole.deleteMany({ where: where.roles })
        ).count;
      }
      if (where.memberships) {
        affected += (
          disposition === GrantDisposition.keep
            ? await tx.membership.updateMany({ where: where.memberships, data: native })
            : await tx.membership.deleteMany({ where: where.memberships })
        ).count;
      }
      return affected;
    };
    if (disposition === GrantDisposition.keep) return this.prisma.$transaction(run);
    return this.admin.withAdminFloor(
      actorUserId,
      { type: 'integration_connection', id: connectionId, path: 'integration.release_grants' },
      run,
    );
  }

  // ---- Helpers ---------------------------------------------------------------

  /** Send a new token to the worker, or just tell its Gateway to catch up. */
  private async handToWorker(connectionId: string, botToken: string | undefined): Promise<void> {
    if (botToken) {
      await this.queue.publish('integration.store-token', { connectionId, botToken } satisfies StoreTokenJob);
    } else {
      await this.signalGateway(connectionId);
    }
  }

  /** Tell the worker to bring the connection's Gateway session in line. */
  private signalGateway(connectionId: string): Promise<void> {
    return this.queue.publish('gateway.reconcile-sessions', { connectionId });
  }

  private async grantedCount(connectionId: string, target: SyncTarget): Promise<number> {
    const where = holdingWhere(connectionId, target);
    const [roles, members] = await Promise.all([
      where.roles ? this.prisma.userRole.count({ where: where.roles }) : 0,
      where.memberships ? this.prisma.membership.count({ where: where.memberships }) : 0,
    ]);
    return roles + members;
  }

  private targetColumns(target: SyncTarget) {
    return {
      roleId: target.kind === 'role' ? target.id : null,
      divisionId: target.kind === 'division' ? target.id : null,
      teamId: target.kind === 'team' ? target.id : null,
    };
  }

  /** The mapping's target: it must exist and be active, and a role mustn't be governance. */
  private async validTarget(dto: CreateMappingDto): Promise<SyncTarget> {
    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
      if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
      if (role.lifecycleState === LifecycleState.retired) {
        throw new UnprocessableError('ROLE_RETIRED', 'Cannot map a retired role');
      }
      if (role.kind === 'unit') {
        throw new UnprocessableError('UNIT_ROLE_NOT_GRANTABLE', 'Unit roles cannot be mapped to an external group');
      }
      await this.assertNotGovernanceRole(dto.roleId);
      return { kind: 'role', id: dto.roleId };
    }
    if (dto.divisionId) {
      const d = await this.prisma.division.findUnique({ where: { id: dto.divisionId } });
      if (!d) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
      if (d.lifecycleState === LifecycleState.retired) throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
      return { kind: 'division', id: dto.divisionId };
    }
    const t = await this.prisma.team.findUnique({ where: { id: dto.teamId! } });
    if (!t) throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    if (t.lifecycleState === LifecycleState.retired) throw new ConflictError('TEAM_RETIRED', 'Team is retired');
    return { kind: 'team', id: dto.teamId! };
  }

  /**
   * Native-Authority Carve-Out (api/CONTEXT.md): a governance role — one with a
   * permit grant for an Effective-Admin action — must never be mapped, so admin
   * revocation is always a synchronous native write. GrantsService enforces the
   * other direction (no governance grant to a role mapped inbound).
   */
  private async assertNotGovernanceRole(roleId: string): Promise<void> {
    const governanceGrant = await this.prisma.grant.findFirst({
      where: { roleId, effect: 'permit', action: { in: [...EFFECTIVE_ADMIN_ACTIONS] } },
      select: { id: true },
    });
    if (governanceGrant) {
      throw new UnprocessableError(
        'GOVERNANCE_ROLE_NOT_MAPPABLE',
        'Security-critical (governance) roles cannot be mapped to an external group',
      );
    }
  }

  private async loadMapping(connectionId: string, mappingId: string) {
    await this.loadActive(connectionId);
    const mapping = await this.prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.connectionId !== connectionId) {
      throw new NotFoundError('MAPPING_NOT_FOUND', 'Mapping not found');
    }
    return mapping;
  }

  async loadActive(id: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection || connection.lifecycleState !== LifecycleState.active) {
      throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    }
    return connection;
  }
}
