import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { RolesService } from './roles.service';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleDto,
  type UpdateRoleDto,
} from './roles.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Standalone-role configuration surface (Slice 2.1). Every route is governance-
 * scoped: the resource is the singleton org, so all use `orgResource`. Lifecycle
 * transitions are named action endpoints (retire/revive), not PATCH.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Authorize(ACTIONS.roleCreate.action, orgResource)
  async list(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.roles.list(req.user.organizationId);
  }

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.roleCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.roles.create(req.user.organizationId, req.user.id, body);
  }

  @Patch(':id')
  @Authorize(ACTIONS.roleUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.roles.update(id, req.user.id, body);
  }

  @Post(':id/retire')
  @Authorize(ACTIONS.roleRetire.action, orgResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.roles.retire(id, req.user.id);
  }

  @Post(':id/revive')
  @Authorize(ACTIONS.roleRevive.action, orgResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.roles.revive(id, req.user.id);
  }
}
