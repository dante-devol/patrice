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
import { TeamsService } from './teams.service';
import {
  createTeamSchema,
  updateTeamSchema,
  type CreateTeamDto,
  type UpdateTeamDto,
} from './teams.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @Authorize(ACTIONS.teamCreate.action, orgResource)
  async list(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.teams.list(req.user.organizationId);
  }

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.teamCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createTeamSchema)) body: CreateTeamDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.teams.create(req.user.organizationId, req.user.id, body);
  }

  @Patch(':id')
  @Authorize(ACTIONS.teamUpdate.action, orgResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTeamSchema)) body: UpdateTeamDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.teams.update(id, req.user.id, body);
  }

  @Post(':id/retire')
  @Authorize(ACTIONS.teamRetire.action, orgResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.teams.retire(id, req.user.id);
  }

  @Post(':id/revive')
  @Authorize(ACTIONS.teamRevive.action, orgResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.teams.revive(id, req.user.id);
  }
}
