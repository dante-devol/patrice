import {
  Body,
  Controller,
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
  createGrantSchema,
  updateGrantSchema,
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

  /** The closed action vocabulary — feeds the matrix's column axis. */
  @Contract(ROUTES.listActions)
  @Get('actions')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  listActions() {
    return { actions: this.grants.listActions() };
  }

  @Contract(ROUTES.listGrants)
  @Get('grants')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  async list(@Query('include') include: string | undefined) {
    return this.grants.list(include === 'retired');
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

  @Contract(ROUTES.retireGrant)
  @Post('grants/:id/retire')
  @Authorize(ACTIONS.grantRetire.action, orgResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.grants.retire(id, user.id);
  }

  @Contract(ROUTES.reviveGrant)
  @Post('grants/:id/revive')
  @Authorize(ACTIONS.grantRevive.action, orgResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.grants.revive(id, user.id);
  }
}
