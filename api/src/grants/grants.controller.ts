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
import { GrantsService } from './grants.service';
import {
  createGrantSchema,
  updateGrantSchema,
  type CreateGrantDto,
  type UpdateGrantDto,
} from './grants.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/** Permission-matrix surface (Slice 2.3). Governance-scoped → `orgResource`. */
@Controller()
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  /** The closed action vocabulary — feeds the matrix's column axis. */
  @Get('actions')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  listActions() {
    return { actions: this.grants.listActions() };
  }

  @Get('grants')
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  async list(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.grants.list(req.user.organizationId);
  }

  @Post('grants')
  @HttpCode(201)
  @Authorize(ACTIONS.grantCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createGrantSchema)) body: CreateGrantDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.grants.create(req.user.organizationId, req.user.id, body);
  }

  @Patch('grants/:id')
  @Authorize(ACTIONS.grantUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateGrantSchema)) body: UpdateGrantDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.grants.update(id, req.user.id, body);
  }

  @Post('grants/:id/retire')
  @Authorize(ACTIONS.grantRetire.action, orgResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.grants.retire(id, req.user.id);
  }

  @Post('grants/:id/revive')
  @Authorize(ACTIONS.grantRevive.action, orgResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.grants.revive(id, req.user.id);
  }
}
