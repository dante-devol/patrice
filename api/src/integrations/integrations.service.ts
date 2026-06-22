import { createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Inject } from '@nestjs/common';
import { LifecycleState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { GraceService } from '../common/grace.service';
import { ENV, Env } from '../config/env';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { activeFilter, isRevivable } from '../common/lifecycle';
import {
  ConnectIntegrationDto,
  UpdateIntegrationDto,
  CreateMappingDto,
  UpdateMappingDto,
} from './integrations.dto';

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------------------
  // Connection CRUD
  // ---------------------------------------------------------------------------

  async list(organizationId: string, includeRetired: boolean) {
    return this.prisma.integrationConnection.findMany({
      where: { organizationId, ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
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
    return connection;
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
    return updated;
  }

  async retire(id: string, actorUserId: string) {
    const connection = await this.loadActive(id);
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
    return updated;
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
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Discord OAuth account linking (external_identity)
  // ---------------------------------------------------------------------------

  private signState(payload: string): string {
    return createHmac('sha256', this.env.SESSION_SECRET).update(payload).digest('hex');
  }

  private buildState(connectionId: string, userId: string): string {
    const payload = JSON.stringify({ connectionId, userId });
    const sig = this.signState(payload);
    return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
  }

  private parseState(state: string): { connectionId: string; userId: string } {
    let envelope: { payload: string; sig: string };
    try {
      envelope = JSON.parse(Buffer.from(state, 'base64url').toString()) as {
        payload: string;
        sig: string;
      };
    } catch {
      throw new UnprocessableError('INVALID_STATE', 'Invalid OAuth state');
    }
    const expected = Buffer.from(this.signState(envelope.payload));
    const received = Buffer.from(envelope.sig);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new UnprocessableError('INVALID_STATE', 'OAuth state signature invalid');
    }
    return JSON.parse(envelope.payload) as { connectionId: string; userId: string };
  }

  /** Begin Discord OAuth link flow for the current user. Returns a redirect URL. */
  startDiscordLink(connectionId: string, userId: string, baseUrl: string): string {
    if (!this.env.DISCORD_CLIENT_ID) {
      throw new UnprocessableError('DISCORD_NOT_CONFIGURED', 'Discord integration is not configured');
    }
    const state = this.buildState(connectionId, userId);
    const params = new URLSearchParams({
      client_id: this.env.DISCORD_CLIENT_ID,
      redirect_uri: `${baseUrl}/integrations/${connectionId}/link/callback`,
      response_type: 'code',
      scope: 'identify guilds.members.read',
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  /** Complete Discord OAuth link: exchange code, store external_identity. */
  async completeDiscordLink(
    connectionId: string,
    code: string,
    state: string,
    baseUrl: string,
  ) {
    if (!this.env.DISCORD_CLIENT_ID || !this.env.DISCORD_CLIENT_SECRET) {
      throw new UnprocessableError('DISCORD_NOT_CONFIGURED', 'Discord integration is not configured');
    }

    const parsedState = this.parseState(state);
    if (parsedState.connectionId !== connectionId) {
      throw new UnprocessableError('STATE_MISMATCH', 'OAuth state connection mismatch');
    }

    const connection = await this.loadActive(connectionId);

    // Exchange the authorization code for tokens.
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.DISCORD_CLIENT_ID,
        client_secret: this.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${baseUrl}/integrations/${connectionId}/link/callback`,
      }),
    });
    if (!tokenRes.ok) {
      throw new UnprocessableError('DISCORD_TOKEN_ERROR', 'Failed to exchange Discord OAuth code');
    }
    const tokens = (await tokenRes.json()) as { access_token: string };

    // Fetch the Discord user to get their stable ID.
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) {
      throw new UnprocessableError('DISCORD_USER_ERROR', 'Failed to fetch Discord user');
    }
    const discordUser = (await userRes.json()) as { id: string; username: string };

    const existing = await this.prisma.externalIdentity.findUnique({
      where: {
        userId_connectionId: { userId: parsedState.userId, connectionId },
      },
    });
    if (existing) {
      throw new ConflictError('ALREADY_LINKED', 'This user is already linked to this connection');
    }

    const identity = await this.prisma.externalIdentity.create({
      data: {
        userId: parsedState.userId,
        connectionId,
        externalUserId: discordUser.id,
        externalHandle: discordUser.username,
      },
    });

    await this.activity.logActivity({
      organizationId: connection.organizationId,
      actorUserId: parsedState.userId,
      subjectType: 'external_identity',
      subjectId: identity.id,
      verb: 'external_identity.linked',
      payload: { connectionId, userId: parsedState.userId, externalIdentityId: identity.id },
    });

    return identity;
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
      data: { ...(dto.syncDirection !== undefined && { syncDirection: dto.syncDirection }) },
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

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async loadActive(id: string) {
    const connection = await this.prisma.integrationConnection.findUnique({ where: { id } });
    if (!connection) throw new NotFoundError('CONNECTION_NOT_FOUND', 'Integration connection not found');
    return connection;
  }
}
