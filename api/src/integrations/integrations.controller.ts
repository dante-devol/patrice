import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { IntegrationsService } from './integrations.service';
import { SyncService } from './sync/sync.service';
import {
  connectIntegrationSchema,
  createMappingSchema,
  updateIntegrationSchema,
  updateMappingSchema,
  rotateTokenSchema,
  type ConnectIntegrationDto,
  type CreateMappingDto,
  type UpdateIntegrationDto,
  type UpdateMappingDto,
  type RotateTokenDto,
} from './integrations.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly sync: SyncService,
  ) {}

  @Get()
  @Authorize(ACTIONS.integrationCreate.action, orgResource)
  async list(@Query('include') include: string | undefined, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.list(req.user.organizationId, include === 'retired');
  }

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.integrationCreate.action, orgResource)
  async connect(
    @Body(new ZodValidationPipe(connectIntegrationSchema)) body: ConnectIntegrationDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.connect(req.user.organizationId, req.user.id, body);
  }

  @Patch(':id')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateIntegrationSchema)) body: UpdateIntegrationDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.update(id, req.user.id, body);
  }

  @Post(':id/rotate-token')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async rotateToken(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rotateTokenSchema)) body: RotateTokenDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.rotateToken(id, req.user.id, body);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationRetire.action, orgResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.retire(id, req.user.id);
  }

  @Post(':id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationRevive.action, orgResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.revive(id, req.user.id);
  }

  // Discord account linking is user-driven and lives under /auth/discord/link
  // (DiscordAuthController) — one OAuth client + redirect URI for login/register/link.

  // Role↔group mappings
  @Get(':id/mappings')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async listMappings(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.listMappings(id);
  }

  @Post(':id/mappings')
  @HttpCode(201)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async createMapping(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createMappingSchema)) body: CreateMappingDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.createMapping(id, req.user.id, body);
  }

  @Patch(':id/mappings/:mappingId')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async updateMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Body(new ZodValidationPipe(updateMappingSchema)) body: UpdateMappingDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.integrations.updateMapping(id, mappingId, req.user.id, body);
  }

  @Delete(':id/mappings/:mappingId')
  @HttpCode(204)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async deleteMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    await this.integrations.deleteMapping(id, mappingId, req.user.id);
  }

  // Clear a broken mapping's flag and re-run sync (admin recovery, no dev needed).
  @Post(':id/mappings/:mappingId/retry')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async retryMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    const mapping = await this.integrations.retryMapping(id, mappingId, req.user.id);
    await this.sync.enqueue(id);
    return mapping;
  }

  // Sync trigger
  @Post(':id/sync')
  @HttpCode(202)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async triggerSync(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    await this.integrations.requestManualSync(id, req.user.id);
    await this.sync.enqueue(id);
    return { queued: true };
  }
}
