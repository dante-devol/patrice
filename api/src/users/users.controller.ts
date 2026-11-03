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
import { Authorize, userResource, userWithRoleResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { UsersService } from './users.service';
import {
  grantRoleSchema,
  updateUserSchema,
  type GrantRoleDto,
  type UpdateUserDto,
} from './users.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Contract(ROUTES.listUsers)
  @Get()
  async list(@Query('include') include: string | undefined, @CurrentUser() user: CurrentUserRef) {
    // Lists show what the caller may read; the service filters per row.
    return this.users.list(user.id, include === 'retired');
  }

  @Contract(ROUTES.updateUser)
  @Patch(':id')
  @Authorize(ACTIONS.userUpdate.action, userResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.users.update(id, user.id, body);
  }

  @Contract(ROUTES.deactivateUser)
  @Post(':id/deactivate')
  @HttpCode(204)
  @Authorize(ACTIONS.userDeactivate.action, userResource)
  async deactivate(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.users.deactivate(id, user.id);
  }

  @Contract(ROUTES.reactivateUser)
  @Post(':id/reactivate')
  @HttpCode(204)
  @Authorize(ACTIONS.userReactivate.action, userResource)
  async reactivate(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.users.reactivate(id, user.id);
  }

  @Contract(ROUTES.retireUser)
  @Post(':id/retire')
  @HttpCode(204)
  @Authorize(ACTIONS.userRetire.action, userResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.users.retire(id, user.id);
  }

  @Contract(ROUTES.reviveUser)
  @Post(':id/revive')
  @HttpCode(204)
  @Authorize(ACTIONS.userRevive.action, userResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.users.revive(id, user.id);
  }

  @Contract(ROUTES.grantUserRole)
  @Post(':id/roles')
  @HttpCode(204)
  // Scope check at the boundary: the actor must hold user:grant_role covering the
  // specific role (global, or role-scoped to this role).
  @Authorize(ACTIONS.userGrantRole.action, userWithRoleResource)
  async grantRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(grantRoleSchema)) body: GrantRoleDto,
    @Req() req: Request,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.users.grantRole(id, body.roleId, user.id);
  }

  @Contract(ROUTES.revokeUserRole)
  @Delete(':id/roles/:roleId')
  @HttpCode(204)
  @Authorize(ACTIONS.userRevokeRole.action, userWithRoleResource)
  async revokeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: Request,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.users.revokeRole(id, roleId, user.id);
  }
}
