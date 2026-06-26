import { Injectable, Inject } from '@nestjs/common';
import { LifecycleState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { GraceService } from '../common/grace.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { EFFECTIVE_ADMIN_ACTIONS } from '../access/actions';
import {
  ConnectIntegrationDto,
  UpdateIntegrationDto,
  CreateMappingDto,
  UpdateMappingDto,
  RotateTokenDto,
} from './integrations.dto';
import { SECRET_CIPHER_PORT, type SecretCipherPort } from './secret-cipher.port';

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

// Reconcile Floor bounds (mirror SyncService): 6h when the Gateway is healthy,
// 30min when degraded. Used to surface "next reconcile" to admins (api/CONTEXT.md).
const FLOOR_HEALTHY_MS = 6 * 60 * 60 * 1000;
const FLOOR_DEGRADED_MS = 30 * 60 * 1000;

/**
 * Compute the latest time the Reconcile Floor guarantees a sync by. Null until the
 * first sync runs. When the Gateway is degraded the floor tightens, so the next
 * guaranteed reconcile is sooner.
 */
export function computeNextReconcileAt(conn: {
  lastSyncAt: Date | null;
  gatewayState: string;
}): Date | null {
  if (!conn.lastSyncAt) return null;
  const floorMs = conn.gatewayState === 'connected' ? FLOOR_HEALTHY_MS : FLOOR_DEGRADED_MS;
  return new Date(conn.lastSyncAt.getTime() + floorMs);
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
    @Inject(SECRET_CIPHER_PORT) private readonly cipher: SecretCipherPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Connection CRUD
  // ---------------------------------------------------------------------------

  async list(organizationId: string, includeRetired: boolean) {
    const rows = await this.prisma.integrationConnection.findMany({
      where: { organizationId, ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => ({
      ...toConnectionResponse(c),
      nextReconcileAt: computeNextReconcileAt(c),
    }));
  }

  async connect(organizationId: string, actorUserId: string, dto: ConnectIntegrationDto) {
    const existing = await this.prisma.integrationConnection.findFirst({
      where: {
        organizationId,
        provider: dto.provider,
        externalWorkspaceId: dto.externalWorkspaceId,
        lifecycleState: { not: LifecycleState.retired },
      },
    });
    if (existing) {
      throw new ConflictError('DUPLICATE_CONNECTION', 'A connection for this workspace already exists');
    }

    const connection = await this.prisma.integrationConnection.create({
      data: {
        organizationId,
        provider: dto.provider,
        externalWorkspaceId: dto.externalWorkspaceId,
        displayName: dto.displayName,
        config: (dto.config ?? {}) as Prisma.InputJsonValue,
        credentialsRef: dto.credentialsRef ?? null,
      },
    });
    await this.activity.logActivity({
      organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: connection.id,
      verb: 'integration.connected',
      payload: { connectionId: connection.id },
    });
    return toConnectionResponse(connection);
  }

  async update(id: string, actorUserId: string, dto: UpdateIntegrationDto) {
    const connection = await this.loadActive(id);
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined && { displayName: dto.displayName }),
        ...(dto.config !== undefined && { config: dto.config as Prisma.InputJsonValue }),
        ...(dto.credentialsRef !== undefined && { credentialsRef: dto.credentialsRef }),
      },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.updated',
      payload: { connectionId: id },
    });
    return toConnectionResponse(updated);
  }

  /**
   * Re-encrypt the bot token and store it in credentials_ref. Clears config.botToken.
   * Rotation is write-only — the new ciphertext is never returned.
   */
  async rotateToken(id: string, actorUserId: string, dto: RotateTokenDto) {
    const connection = await this.loadActive(id);
    const ref = await this.cipher.encrypt(dto.botToken);
    // Strip the plaintext token from config to prevent dual-custody.
    const safeConfig = { ...(connection.config as Record<string, unknown>) };
    delete safeConfig['botToken'];
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { credentialsRef: ref, config: safeConfig as Prisma.InputJsonValue },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.token_rotated',
      payload: { connectionId: id },
    });
    return toConnectionResponse(updated);
  }

  async retire(id: string, actorUserId: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    if (connection.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Integration connection is already retired');
    }
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { lifecycleState: LifecycleState.retired, retiredAt: new Date() },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.retired',
      payload: { connectionId: id },
    });
    return toConnectionResponse(updated);
  }

  async revive(id: string, actorUserId: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    const graceMs = await this.grace.windowMs(connection.organizationId);
    if (!isRevivable(connection, graceMs)) {
      throw new ConflictError('NOT_REVIVABLE', 'Connection is not retired or its grace period has elapsed');
    }
    const updated = await this.prisma.integrationConnection.update({
      where: { id },
      data: { lifecycleState: LifecycleState.active, retiredAt: null },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.revived',
      payload: { connectionId: id },
    });
    return toConnectionResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Role↔group mapping CRUD
  // ---------------------------------------------------------------------------

  async listMappings(connectionId: string) {
    await this.loadActive(connectionId);
    return this.prisma.externalGroupMapping.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createMapping(connectionId: string, actorUserId: string, dto: CreateMappingDto) {
    const connection = await this.loadActive(connectionId);

    // Reject mapping a retired role.
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
    if (role.lifecycleState === LifecycleState.retired) {
      throw new UnprocessableError('ROLE_RETIRED', 'Cannot map a retired role');
    }
    // Native-Authority Carve-Out: governance roles stay Patrice-native and must never
    // be granted/revoked through an integration, so their revocation can't be gated on
    // sync latency or a live Gateway (api/CONTEXT.md).
    await this.assertNotGovernanceRole(dto.roleId);

    const existing = await this.prisma.externalGroupMapping.findUnique({
      where: {
        roleId_connectionId_externalGroupId: {
          roleId: dto.roleId,
          connectionId,
          externalGroupId: dto.externalGroupId,
        },
      },
    });
    if (existing) {
      throw new ConflictError('DUPLICATE_MAPPING', 'This mapping already exists');
    }

    const mapping = await this.prisma.externalGroupMapping.create({
      data: {
        roleId: dto.roleId,
        connectionId,
        externalGroupId: dto.externalGroupId,
        syncDirection: dto.syncDirection,
      },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mapping.id,
      verb: 'external_group_mapping.created',
      payload: { mappingId: mapping.id, connectionId, roleId: dto.roleId },
    });
    return mapping;
  }

  async updateMapping(
    connectionId: string,
    mappingId: string,
    actorUserId: string,
    dto: UpdateMappingDto,
  ) {
    const connection = await this.loadActive(connectionId);
    const mapping = await this.prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.connectionId !== connectionId) {
      throw new NotFoundError('MAPPING_NOT_FOUND', 'Mapping not found');
    }
    const updated = await this.prisma.externalGroupMapping.update({
      where: { id: mappingId },
      data: {
        ...(dto.syncDirection !== undefined && { syncDirection: dto.syncDirection }),
        ...(dto.conflictWinner !== undefined && { conflictWinner: dto.conflictWinner }),
        // Re-pointing at a new external group clears the broken flag for re-evaluation.
        ...(dto.externalGroupId !== undefined && {
          externalGroupId: dto.externalGroupId,
          isBroken: false,
        }),
      },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'external_group_mapping.updated',
      payload: { mappingId, connectionId, roleId: mapping.roleId },
    });
    return updated;
  }

  async deleteMapping(connectionId: string, mappingId: string, actorUserId: string) {
    const connection = await this.loadActive(connectionId);
    const mapping = await this.prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.connectionId !== connectionId) {
      throw new NotFoundError('MAPPING_NOT_FOUND', 'Mapping not found');
    }
    await this.prisma.externalGroupMapping.delete({ where: { id: mappingId } });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'external_group_mapping.retired',
      payload: { mappingId, connectionId, roleId: mapping.roleId },
    });
  }

  /** Record an admin-initiated reconcile in the audit log (the enqueue is the caller's). */
  async requestManualSync(id: string, actorUserId: string): Promise<void> {
    const conn = await this.loadActive(id);
    await this.activity.logActivity({
      organizationId: conn.organizationId,
      actorUserId,
      subjectType: 'integration_connection',
      subjectId: id,
      verb: 'integration.reconcile_scheduled',
      payload: { connectionId: id, reason: 'manual' },
    });
  }

  /** Clear a mapping's broken flag so the next sync re-evaluates it (admin recovery). */
  async retryMapping(connectionId: string, mappingId: string, actorUserId: string) {
    const connection = await this.loadActive(connectionId);
    const mapping = await this.prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
    if (!mapping || mapping.connectionId !== connectionId) {
      throw new NotFoundError('MAPPING_NOT_FOUND', 'Mapping not found');
    }
    const updated = await this.prisma.externalGroupMapping.update({
      where: { id: mappingId },
      data: { isBroken: false },
    });
    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId,
      subjectType: 'external_group_mapping',
      subjectId: mappingId,
      verb: 'integration.mapping_retried',
      payload: { mappingId, connectionId, roleId: mapping.roleId },
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Native-Authority Carve-Out (api/CONTEXT.md): a governance role — one with a
   * permit grant for an Effective-Admin action at global scope — must never be
   * mapped to an external group, so admin revocation is always a synchronous native
   * write, never gated on sync latency or a live Gateway.
   */
  private async assertNotGovernanceRole(roleId: string): Promise<void> {
    const governanceGrant = await this.prisma.grant.findFirst({
      where: {
        roleId,
        effect: 'permit',
        scopeKind: 'global',
        lifecycleState: LifecycleState.active,
        action: { in: [...EFFECTIVE_ADMIN_ACTIONS] },
      },
      select: { id: true },
    });
    if (governanceGrant) {
      throw new UnprocessableError(
        'GOVERNANCE_ROLE_NOT_MAPPABLE',
        'Security-critical (governance) roles cannot be mapped to an external group',
      );
    }
  }

  async loadActive(id: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection || connection.lifecycleState !== LifecycleState.active) {
      throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    }
    return connection;
  }
}
