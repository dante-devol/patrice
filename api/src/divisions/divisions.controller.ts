import {
  Body,
  Controller,
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
import { Authorize, divisionResource, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { DivisionsService } from './divisions.service';
import {
  createDivisionSchema,
  updateDivisionSchema,
  type CreateDivisionDto,
  type UpdateDivisionDto,
} from './divisions.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller('divisions')
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  @Get()
  @Authorize(ACTIONS.divisionCreate.action, orgResource)
  async list(@Query('include') include: string | undefined, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.divisions.list(req.user.organizationId, include === 'retired');
  }

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.divisionCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createDivisionSchema)) body: CreateDivisionDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.divisions.create(req.user.organizationId, req.user.id, body);
  }

  @Patch(':id')
  // division:update resolves the Division itself (not the org): carries `retired` so
  // the Retired-as-Hard-Deny forbid blocks edits to a retired division, and the
  // division self-ref so specific_division/own_division grants can scope (Slice 7.2).
  @Authorize(ACTIONS.divisionUpdate.action, divisionResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateDivisionSchema)) body: UpdateDivisionDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.divisions.update(id, req.user.id, body);
  }

  @Post(':id/retire')
  @Authorize(ACTIONS.divisionRetire.action, orgResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.divisions.retire(id, req.user.id);
  }

  @Post(':id/revive')
  @Authorize(ACTIONS.divisionRevive.action, orgResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.divisions.revive(id, req.user.id);
  }
}
