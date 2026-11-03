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
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
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
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly sync: SyncService,
  ) {}

  @Contract(ROUTES.listIntegrations)
  @Get()
  @Authorize(ACTIONS.integrationCreate.action, orgResource)
  async list(@Query('include') include: string | undefined) {
    return this.integrations.list(include === 'retired');
  }

  @Contract(ROUTES.connectIntegration)
  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.integrationCreate.action, orgResource)
  async connect(
    @Body(new ZodValidationPipe(connectIntegrationSchema)) body: ConnectIntegrationDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.integrations.connect(user.id, body);
  }

  @Contract(ROUTES.updateIntegration)
  @Patch(':id')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateIntegrationSchema)) body: UpdateIntegrationDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.integrations.update(id, user.id, body);
  }

  @Contract(ROUTES.rotateIntegrationToken)
  @Post(':id/rotate-token')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async rotateToken(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rotateTokenSchema)) body: RotateTokenDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.integrations.rotateToken(id, user.id, body);
  }

  @Contract(ROUTES.retireIntegration)
  @Post(':id/retire')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationRetire.action, orgResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.integrations.retire(id, user.id);
  }

  @Contract(ROUTES.reviveIntegration)
  @Post(':id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationRevive.action, orgResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.integrations.revive(id, user.id);
  }

  // Discord account linking is user-driven and lives under /auth/discord/link
  // (DiscordAuthController) — one OAuth client + redirect URI for login/register/link.

  // Role↔group mappings
  @Contract(ROUTES.listMappings)
  @Get(':id/mappings')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async listMappings(@Param('id') id: string) {
    return this.integrations.listMappings(id);
  }

  @Contract(ROUTES.createMapping)
  @Post(':id/mappings')
  @HttpCode(201)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async createMapping(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createMappingSchema)) body: CreateMappingDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.integrations.createMapping(id, user.id, body);
  }

  @Contract(ROUTES.updateMapping)
  @Patch(':id/mappings/:mappingId')
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async updateMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @Body(new ZodValidationPipe(updateMappingSchema)) body: UpdateMappingDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.integrations.updateMapping(id, mappingId, user.id, body);
  }

  @Contract(ROUTES.deleteMapping)
  @Delete(':id/mappings/:mappingId')
  @HttpCode(204)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async deleteMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @CurrentUser() user: CurrentUserRef,
  ) {
    await this.integrations.deleteMapping(id, mappingId, user.id);
  }

  // Clear a broken mapping's flag and re-run sync (admin recovery, no dev needed).
  @Contract(ROUTES.retryMapping)
  @Post(':id/mappings/:mappingId/retry')
  @HttpCode(200)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async retryMapping(
    @Param('id') id: string,
    @Param('mappingId') mappingId: string,
    @CurrentUser() user: CurrentUserRef,
  ) {
    const mapping = await this.integrations.retryMapping(id, mappingId, user.id);
    await this.sync.enqueue(id);
    return mapping;
  }

  // Sync trigger
  @Contract(ROUTES.triggerSync)
  @Post(':id/sync')
  @HttpCode(202)
  @Authorize(ACTIONS.integrationUpdate.action, orgResource)
  async triggerSync(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    await this.integrations.requestManualSync(id, user.id);
    await this.sync.enqueue(id);
    return { queued: true };
  }
}
