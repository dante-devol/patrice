import { Controller, Get, Param, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, divisionResource, teamResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { UnitStatsService } from './unit-stats.service';
import { unitStatsQuerySchema, type UnitStatsQueryDto } from './unit-stats.dto';

/** Division and team stats: anyone who can read the unit, over the tasks they can see. */
@Controller()
export class UnitStatsController {
  constructor(private readonly stats: UnitStatsService) {}

  @Contract(ROUTES.divisionStats)
  @Get('divisions/:id/stats')
  @Authorize(ACTIONS.divisionRead.action, divisionResource)
  async division(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(unitStatsQuerySchema)) query: UnitStatsQueryDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.stats.stats('division', id, user.id, query);
  }

  @Contract(ROUTES.teamStats)
  @Get('teams/:id/stats')
  @Authorize(ACTIONS.teamRead.action, teamResource)
  async team(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(unitStatsQuerySchema)) query: UnitStatsQueryDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.stats.stats('team', id, user.id, query);
  }
}
