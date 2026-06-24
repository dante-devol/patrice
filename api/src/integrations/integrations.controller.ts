import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ENV, Env } from '../config/env';
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
  type ConnectIntegrationDto,
  type CreateMappingDto,
  type UpdateIntegrationDto,
  type UpdateMappingDto,
} from './integrations.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly sync: SyncService,
    @Inject(ENV) private readonly env: Env,
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

  // Discord OAuth account link
  @Post(':id/link')
  @HttpCode(200)
  async startLink(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    const redirectUrl = this.integrations.startDiscordLink(
      id,
      req.user.id,
      this.env.PUBLIC_BASE_URL,
    );
    return { redirectUrl };
  }

  @Get(':id/link/callback')
  @Redirect()
  async linkCallback(
    @Param('id') id: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: true }) _res: Response,
  ) {
    await this.integrations.completeDiscordLink(id, code, state, this.env.PUBLIC_BASE_URL);
    return { url: `${this.env.PUBLIC_BASE_URL}/settings/integrations?linked=1`, statusCode: 302 };
  }

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

  // Sync trigger
  @Post(':id/sync')
  @HttpCode(202)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async triggerSync(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    await this.integrations.loadActive(id);
    await this.sync.enqueue(id);
    return { queued: true };
  }
}
