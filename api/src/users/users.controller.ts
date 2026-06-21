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
import { CedarEngine } from '../access/cedar/engine';
import { UsersService } from './users.service';
import {
  grantRoleSchema,
  updateUserSchema,
  type GrantRoleDto,
  type UpdateUserDto,
} from './users.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/** Resolve the target User as a Cedar resource (carries `retired` for hard-deny). */
const targetUser = (req: Request) => ({
  type: 'User' as const,
  id: String(req.params.id),
  attrs: { retired: false },
});

/**
 * The target User for `user:revive` — **omits** `retired` so reviving a retired user
 * doesn't trip the Retired-as-Hard-Deny forbid (mirrors the task/message revive
 * resolvers). Revive is the one action that legitimately targets a retired user.
 */
const reviveUser = (req: Request) => ({
  type: 'User' as const,
  id: String(req.params.id),
  attrs: {},
});

/** Resolve a User whose `targetRole` is the role being granted/revoked (role scope). */
function userWithTargetRole(roleId: string) {
  return (req: Request) => ({
    type: 'User' as const,
    id: String(req.params.id),
    attrs: {
      retired: false,
      targetRole: {
        __entity: { type: CedarEngine.qualify('Role'), id: roleId },
      },
    },
  });
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Authorize(ACTIONS.userUpdate.action, orgResource)
  async list(@Query('include') include: string | undefined, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.users.list(req.user.organizationId, include === 'retired');
  }

  @Patch(':id')
  @Authorize(ACTIONS.userUpdate.action, targetUser)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserSchema)) body: UpdateUserDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.users.update(req.user.organizationId, id, req.user.id, body);
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @Authorize(ACTIONS.userDeactivate.action, targetUser)
  async deactivate(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.deactivate(req.user.organizationId, id, req.user.id);
  }

  @Post(':id/reactivate')
  @HttpCode(204)
  @Authorize(ACTIONS.userReactivate.action, targetUser)
  async reactivate(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.reactivate(req.user.organizationId, id, req.user.id);
  }

  @Post(':id/retire')
  @HttpCode(204)
  @Authorize(ACTIONS.userRetire.action, targetUser)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.retire(req.user.organizationId, id, req.user.id);
  }

  @Post(':id/revive')
  @HttpCode(204)
  @Authorize(ACTIONS.userRevive.action, reviveUser)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.revive(req.user.organizationId, id, req.user.id);
  }

  @Post(':id/roles')
  @HttpCode(204)
  // Scope check at the boundary: the actor must hold user:grant_role covering the
  // specific role (global, or role-scoped to this role).
  @Authorize(ACTIONS.userGrantRole.action, (req) =>
    userWithTargetRole(String((req.body as { roleId?: string }).roleId ?? ''))(req),
  )
  async grantRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(grantRoleSchema)) body: GrantRoleDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.grantRole(req.user.organizationId, id, body.roleId, req.user.id);
  }

  @Delete(':id/roles/:roleId')
  @HttpCode(204)
  @Authorize(ACTIONS.userRevokeRole.action, (req) =>
    userWithTargetRole(String(req.params.roleId))(req),
  )
  async revokeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.users.revokeRole(req.user.organizationId, id, roleId, req.user.id);
  }
}
