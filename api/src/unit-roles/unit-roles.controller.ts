import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, divisionResource, teamResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { UnitRolesService } from './unit-roles.service';
import { assignUnitRoleSchema, type AssignUnitRoleDto } from './unit-roles.dto';

/**
 * Unit roles at a division or team (its leadership). Reading the list needs only
 * `*:read`; assigning and unassigning are checked in the service, because the
 * decision depends on which role is being assigned.
 */
@Controller()
export class UnitRolesController {
  constructor(private readonly unitRoles: UnitRolesService) {}

  @Contract(ROUTES.myUnits)
  @Get('me/units')
  async mine(@CurrentUser() user: CurrentUserRef) {
    return this.unitRoles.mine(user.id);
  }

  @Contract(ROUTES.listDivisionRoleAssignments)
  @Get('divisions/:id/role-assignments')
  @Authorize(ACTIONS.divisionRead.action, divisionResource)
  async listDivision(@Param('id') id: string) {
    return this.unitRoles.list('division', id);
  }

  @Contract(ROUTES.divisionAssignableRoles)
  @Get('divisions/:id/assignable-roles')
  @Authorize(ACTIONS.divisionRead.action, divisionResource)
  async assignableDivision(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.unitRoles.assignableRoles('division', id, user.id);
  }

  @Contract(ROUTES.assignDivisionRole)
  @Post('divisions/:id/role-assignments')
  @HttpCode(201)
  async assignDivision(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignUnitRoleSchema)) body: AssignUnitRoleDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.unitRoles.assign('division', id, user.id, body);
  }

  @Contract(ROUTES.unassignDivisionRole)
  @Delete('divisions/:id/role-assignments/:assignmentId')
  @HttpCode(204)
  async unassignDivision(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.unitRoles.unassign('division', id, assignmentId, user.id);
  }

  @Contract(ROUTES.listTeamRoleAssignments)
  @Get('teams/:id/role-assignments')
  @Authorize(ACTIONS.teamRead.action, teamResource)
  async listTeam(@Param('id') id: string) {
    return this.unitRoles.list('team', id);
  }

  @Contract(ROUTES.teamAssignableRoles)
  @Get('teams/:id/assignable-roles')
  @Authorize(ACTIONS.teamRead.action, teamResource)
  async assignableTeam(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.unitRoles.assignableRoles('team', id, user.id);
  }

  @Contract(ROUTES.assignTeamRole)
  @Post('teams/:id/role-assignments')
  @HttpCode(201)
  async assignTeam(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignUnitRoleSchema)) body: AssignUnitRoleDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.unitRoles.assign('team', id, user.id, body);
  }

  @Contract(ROUTES.unassignTeamRole)
  @Delete('teams/:id/role-assignments/:assignmentId')
  @HttpCode(204)
  async unassignTeam(
    @Param('id') id: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.unitRoles.unassign('team', id, assignmentId, user.id);
  }
}
