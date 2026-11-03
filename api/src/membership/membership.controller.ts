import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, divisionResource, teamResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { MembershipService } from './membership.service';
import { addMemberSchema, type AddMemberDto } from './membership.dto';

/** Division and team membership. Reading a unit's members needs only `*:read`. */
@Controller()
export class MembershipController {
  constructor(private readonly members: MembershipService) {}

  @Contract(ROUTES.listDivisionMembers)
  @Get('divisions/:id/members')
  @Authorize(ACTIONS.divisionRead.action, divisionResource)
  async listDivision(@Param('id') id: string) {
    return this.members.list('division', id);
  }

  @Contract(ROUTES.addDivisionMember)
  @Post('divisions/:id/members')
  @HttpCode(200)
  @Authorize(ACTIONS.divisionManageMembers.action, divisionResource)
  async addDivision(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.members.add('division', id, body.userId, user.id);
  }

  @Contract(ROUTES.removeDivisionMember)
  @Delete('divisions/:id/members/:userId')
  @HttpCode(204)
  @Authorize(ACTIONS.divisionManageMembers.action, divisionResource)
  async removeDivision(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.members.remove('division', id, userId, user.id);
  }

  @Contract(ROUTES.listTeamMembers)
  @Get('teams/:id/members')
  @Authorize(ACTIONS.teamRead.action, teamResource)
  async listTeam(@Param('id') id: string) {
    return this.members.list('team', id);
  }

  @Contract(ROUTES.addTeamMember)
  @Post('teams/:id/members')
  @HttpCode(200)
  @Authorize(ACTIONS.teamManageMembers.action, teamResource)
  async addTeam(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.members.add('team', id, body.userId, user.id);
  }

  @Contract(ROUTES.removeTeamMember)
  @Delete('teams/:id/members/:userId')
  @HttpCode(204)
  @Authorize(ACTIONS.teamManageMembers.action, teamResource)
  async removeTeam(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.members.remove('team', id, userId, user.id);
  }
}
