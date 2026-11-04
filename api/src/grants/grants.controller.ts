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
import { GrantsService } from './grants.service';
import {
  batchGrantsSchema,
  createGrantSchema,
  updateGrantSchema,
  type BatchGrantsDto,
  type CreateGrantDto,
  type UpdateGrantDto,
} from './grants.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/** Permission-matrix surface (Slice 2.3). Governance-scoped → `orgResource`. */
@Controller()
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  /** The closed action vocabulary, with each action's assignable scopes for the editor. */
  @Contract(ROUTES.listActions)
  @Get('actions')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  listActions() {
    return { actions: this.grants.listActions(), catalog: this.grants.actionCatalog() };
  }

  @Contract(ROUTES.listGrants)
  @Get('grants')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  async list() {
    return this.grants.list();
  }

  @Contract(ROUTES.createGrant)
  @Post('grants')
  @HttpCode(201)
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createGrantSchema)) body: CreateGrantDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.grants.create(user.id, body);
  }

  /** The editor's staged changes, all-or-nothing. Creates and deletes need their own action. */
  @Contract(ROUTES.batchGrants)
  @Post('grants/batch')
  @HttpCode(200)
  @Authorize(ACTIONS.grantUpdate.action, orgResource)
  async batch(
    @Body(new ZodValidationPipe(batchGrantsSchema)) body: BatchGrantsDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.grants.applyBatch(user.id, body);
  }

  @Contract(ROUTES.updateGrant)
  @Patch('grants/:id')
  @Authorize(ACTIONS.grantUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateGrantSchema)) body: UpdateGrantDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.grants.update(id, user.id, body);
  }

  @Contract(ROUTES.deleteGrant)
  @Delete('grants/:id')
  @HttpCode(204)
  @Authorize(ACTIONS.grantDelete.action, orgResource)
  async delete(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.grants.delete(id, user.id);
  }
}
