import { Injectable } from '@nestjs/common';
import { LifecycleState, Team } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { EntityLoader, teamRef } from '../access/entity-loader';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { CreateTeamDto, UpdateTeamDto } from './teams.dto';
import { diffFields } from '../activity/changes';

export interface TeamView {
  id: string;
  divisionId: string;
  name: string;
  restrictClaims: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
}

const toView = (t: Team): TeamView => ({
  id: t.id,
  divisionId: t.divisionId,
  name: t.name,
  restrictClaims: t.restrictClaims,
  lifecycleState: t.lifecycleState,
  retiredAt: t.retiredAt,
  version: t.version,
});

/**
 * Teams. A team belongs to one division; membership is managed separately (see
 * MembershipService) and grants no authority by itself.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
  ) {}

  /** The teams the user may see (`team:read`). */
  async list(userId: string, includeRetired = false): Promise<TeamView[]> {
    const rows = await this.prisma.team.findMany({
      where: { ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
    return (await this.access.filterAllowed(userId, ACTIONS.teamRead.action, rows, teamRef)).map(toView);
  }

  /** `team:create` targets the team's division, so a division admin can be scoped to it. */
  async create(actorUserId: string, dto: CreateTeamDto): Promise<TeamView> {
    const division = await this.prisma.division.findUnique({ where: { id: dto.divisionId } });
    if (!division) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    await this.access.assert(
      actorUserId,
      ACTIONS.teamCreate.action,
      await new EntityLoader(this.prisma).division(division.id),
    );
    if (division.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
    }
    const team = await this.prisma.$transaction(async (tx) => {
      const t = await tx.team.create({
        data: { divisionId: dto.divisionId, name: dto.name, restrictClaims: dto.restrictClaims ?? false },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'team',
        subjectId: t.id,
        verb: 'team.created',
        payload: { teamId: t.id },
      });
      return t;
    });
    return toView(team);
  }

  private async load(id: string): Promise<Team> {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    return team;
  }

  async update(id: string, actorUserId: string, dto: UpdateTeamDto): Promise<TeamView> {
    const team = await this.load(id);
    if (team.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TEAM_RETIRED', 'Team is retired');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      // Version-guarded when the client says which version it edited.
      const { count } = await tx.team.updateMany({
        where: { id: team.id, ...(dto.version !== undefined ? { version: dto.version } : {}) },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.restrictClaims !== undefined ? { restrictClaims: dto.restrictClaims } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new ConflictError('STALE_VERSION', 'The team changed since it was read; reload and retry');
      }
      const updated = await tx.team.findUniqueOrThrow({ where: { id: team.id } });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.updated',
        payload: { teamId: team.id, changes: diffFields(team, updated, ['name', 'restrictClaims']) },
      });
      return updated;
    });
    return toView(row);
  }

  async retire(id: string, actorUserId: string): Promise<TeamView> {
    const team = await this.load(id);
    if (team.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Team is already retired');
    }
    return this.setLifecycle(team, actorUserId, 'retired');
  }

  async revive(id: string, actorUserId: string): Promise<TeamView> {
    const team = await this.load(id);
    if (!isRevivable(team, await this.grace.windowMs())) {
      throw new ConflictError('NOT_REVIVABLE', 'Team is not retired or its grace period has elapsed');
    }
    return this.setLifecycle(team, actorUserId, 'revived');
  }

  private async setLifecycle(team: Team, actorUserId: string, kind: 'retired' | 'revived'): Promise<TeamView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: team.id },
        data: {
          lifecycleState: kind === 'retired' ? LifecycleState.retired : LifecycleState.active,
          retiredAt: kind === 'retired' ? new Date() : null,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: kind === 'retired' ? 'team.retired' : 'team.revived',
        payload: { teamId: team.id },
      });
      return updated;
    });
    return toView(row);
  }
}
