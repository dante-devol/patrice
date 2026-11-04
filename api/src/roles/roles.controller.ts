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
import { RolesService } from './roles.service';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleDto,
  type UpdateRoleDto,
} from './roles.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Standalone-role configuration surface. Every route is governance-
 * scoped: the resource is the singleton org, so all use `orgResource`. Lifecycle
 * transitions are named action endpoints (retire/revive), not PATCH.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Contract(ROUTES.listRoles)
  @Get()
  async list(@Query('include') include: string | undefined, @CurrentUser() user: CurrentUserRef) {
    // Lists show what the caller may read; the service filters per row.
    return this.roles.list(user.id, include === 'retired');
  }

  @Contract(ROUTES.createRole)
  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.roleCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.roles.create(user.id, body);
  }

  @Contract(ROUTES.updateRole)
  @Patch(':id')
  @Authorize(ACTIONS.roleUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.roles.update(id, user.id, body);
  }

  @Contract(ROUTES.retireRole)
  @Post(':id/retire')
  @Authorize(ACTIONS.roleRetire.action, orgResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.roles.retire(id, user.id);
  }

  @Contract(ROUTES.reviveRole)
  @Post(':id/revive')
  @Authorize(ACTIONS.roleRevive.action, orgResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.roles.revive(id, user.id);
  }
}
