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
import { Authorize, teamResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { TeamsService } from './teams.service';
import {
  createTeamSchema,
  updateTeamSchema,
  type CreateTeamDto,
  type UpdateTeamDto,
} from './teams.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Contract(ROUTES.listTeams)
  @Get()
  async list(@Query('include') include: string | undefined, @CurrentUser() user: CurrentUserRef) {
    // Lists show what the caller may read; the service filters per row.
    return this.teams.list(user.id, include === 'retired');
  }

  @Contract(ROUTES.createTeam)
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createTeamSchema)) body: CreateTeamDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.teams.create(user.id, body);
  }

  @Contract(ROUTES.updateTeam)
  @Patch(':id')
  @Authorize(ACTIONS.teamUpdate.action, teamResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTeamSchema)) body: UpdateTeamDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.teams.update(id, user.id, body);
  }

  @Contract(ROUTES.retireTeam)
  @Post(':id/retire')
  @Authorize(ACTIONS.teamRetire.action, teamResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.teams.retire(id, user.id);
  }

  @Contract(ROUTES.reviveTeam)
  @Post(':id/revive')
  @Authorize(ACTIONS.teamRevive.action, teamResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.teams.revive(id, user.id);
  }
}
