import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { TEAM_REF_SELECT, teamRef, teamRefOf } from '../access/entity-loader';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { CreateTeamDto, UpdateTeamDto } from './teams.dto';
import { diffFields } from '../activity/changes';

export interface TeamView {
  id: string;
  /** The divisions the team supports; empty when it supports all of them. */
  divisionIds: string[];
  allDivisions: boolean;
  name: string;
  restrictClaims: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
}

const TEAM_SELECT = {
  ...TEAM_REF_SELECT,
  name: true,
  lifecycleState: true,
  retiredAt: true,
  version: true,
  divisions: { select: { divisionId: true }, orderBy: { divisionId: 'asc' } },
} as const satisfies Prisma.TeamSelect;

type TeamRow = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>;

const divisionIdsOf = (t: { allDivisions: boolean; divisions: { divisionId: string }[] }): string[] =>
  t.allDivisions ? [] : t.divisions.map((d) => d.divisionId);

const toView = (t: TeamRow): TeamView => ({
  id: t.id,
  divisionIds: divisionIdsOf(t),
  allDivisions: t.allDivisions,
  name: t.name,
  restrictClaims: t.restrictClaims,
  lifecycleState: t.lifecycleState,
  retiredAt: t.retiredAt,
  version: t.version,
});

/** The divisions a team supports: all of them, or a list. */
interface DivisionSet {
  allDivisions: boolean;
  divisionIds: string[];
}

/**
 * Teams. A team supports one division, several, or all of them; membership is managed
 * separately (see MembershipService) and grants no authority by itself. Who may run a
 * team follows from its divisions (ADR 0020): division authority reaches only a team
 * with exactly that one division.
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
      select: TEAM_SELECT,
    });
    return (await this.access.filterAllowed(userId, ACTIONS.teamRead.action, rows, teamRefOf)).map(toView);
  }

  /**
   * `team:create` is asserted on the proposed team: its id is generated up front, its
   * entity built from the requested divisions, and that same team is then inserted. So
   * a division-scoped grant permits single-division teams in that division only.
   */
  async create(actorUserId: string, dto: CreateTeamDto): Promise<TeamView> {
    const wanted = await this.divisionSet(dto.allDivisions === true, dto.divisionIds ?? []);
    const id = uuidv7();
    const restrictClaims = dto.restrictClaims ?? false;
    await this.access.assert(actorUserId, ACTIONS.teamCreate.action, teamRef({ id, restrictClaims, ...wanted }));
    const team = await this.prisma.$transaction(async (tx) => {
      await tx.team.create({
        data: {
          id,
          name: dto.name,
          restrictClaims,
          allDivisions: wanted.allDivisions,
          divisions: { create: wanted.divisionIds.map((divisionId) => ({ divisionId })) },
        },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'team',
        subjectId: id,
        verb: 'team.created',
        payload: { teamId: id },
      });
      return tx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });
    return toView(team);
  }

  private async load(id: string): Promise<TeamRow> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: TEAM_SELECT });
    if (!team) throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    return team;
  }

  /**
   * Edit a team. Changing its divisions is checked on the team as it is (the route
   * guard) **and** as it would be, so nobody can widen a team beyond their reach, or
   * take over a multi-division team by narrowing it. Dropping a division the team's
   * tasks use is refused (`TEAM_DIVISION_IN_USE`).
   */
  async update(id: string, actorUserId: string, dto: UpdateTeamDto): Promise<TeamView> {
    const team = await this.load(id);
    if (team.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TEAM_RETIRED', 'Team is retired');
    }
    const before: DivisionSet = { allDivisions: team.allDivisions, divisionIds: divisionIdsOf(team) };
    let after: DivisionSet | null = null;
    if (dto.allDivisions !== undefined || dto.divisionIds !== undefined) {
      // Divisions the team already lists may be retired; only newly added ones must be active.
      const next = await this.divisionSet(dto.allDivisions === true, dto.divisionIds ?? [], before.divisionIds);
      if (!sameSet(before, next)) after = next;
    }
    if (after) {
      await this.access.assert(
        actorUserId,
        ACTIONS.teamUpdate.action,
        teamRef({ id: team.id, restrictClaims: dto.restrictClaims ?? team.restrictClaims, ...after }),
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      // Version-guarded when the client says which version it edited.
      const { count } = await tx.team.updateMany({
        where: { id: team.id, ...(dto.version !== undefined ? { version: dto.version } : {}) },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.restrictClaims !== undefined ? { restrictClaims: dto.restrictClaims } : {}),
          ...(after ? { allDivisions: after.allDivisions } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new ConflictError('STALE_VERSION', 'The team changed since it was read; reload and retry');
      }
      if (after) await this.replaceDivisions(tx, team.id, after);
      const updated = await tx.team.findUniqueOrThrow({ where: { id: team.id }, select: TEAM_SELECT });
      const fields = diffFields(team, updated, ['name', 'restrictClaims']);
      const describe = (d: DivisionSet) => (d.allDivisions ? 'all' : d.divisionIds);
      const changes = after ? { ...fields, divisions: { from: describe(before), to: describe(after) } } : fields;
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.updated',
        payload: { teamId: team.id, changes },
      });
      return updated;
    });
    return toView(row);
  }

  /** Write the new division list, after checking no task is left in a dropped division. */
  private async replaceDivisions(tx: Prisma.TransactionClient, teamId: string, after: DivisionSet): Promise<void> {
    if (!after.allDivisions) {
      const inUse = await tx.task.groupBy({
        by: ['divisionId'],
        where: { teamId, divisionId: { notIn: after.divisionIds } },
        _count: { _all: true },
      });
      if (inUse.length > 0) {
        const names = new Map(
          (
            await tx.division.findMany({
              where: { id: { in: inUse.map((r) => r.divisionId) } },
              select: { id: true, name: true },
            })
          ).map((d) => [d.id, d.name]),
        );
        const parts = inUse.map((r) => `${r._count._all} in ${names.get(r.divisionId) ?? 'a division'}`);
        throw new ConflictError(
          'TEAM_DIVISION_IN_USE',
          `The team still has tasks there (${parts.join(', ')}), so it must keep supporting ${
            inUse.length === 1 ? 'that division' : 'those divisions'
          }`,
          { divisions: inUse.map((r) => ({ divisionId: r.divisionId, tasks: r._count._all })) },
        );
      }
    }
    await tx.teamDivision.deleteMany({
      where: { teamId, ...(after.allDivisions ? {} : { divisionId: { notIn: after.divisionIds } }) },
    });
    if (!after.allDivisions) {
      await tx.teamDivision.createMany({
        data: after.divisionIds.map((divisionId) => ({ teamId, divisionId })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * Resolve a requested division set: every listed division must exist, and any not
   * already on the team must be active (`DIVISION_RETIRED`).
   */
  private async divisionSet(
    allDivisions: boolean,
    requested: string[],
    existing: string[] = [],
  ): Promise<DivisionSet> {
    if (allDivisions) return { allDivisions: true, divisionIds: [] };
    const divisionIds = [...new Set(requested)].sort();
    const rows = await this.prisma.division.findMany({
      where: { id: { in: divisionIds } },
      select: { id: true, lifecycleState: true },
    });
    if (rows.length !== divisionIds.length) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    if (rows.some((d) => d.lifecycleState === LifecycleState.retired && !existing.includes(d.id))) {
      throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
    }
    return { allDivisions: false, divisionIds };
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

  private async setLifecycle(team: TeamRow, actorUserId: string, kind: 'retired' | 'revived'): Promise<TeamView> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.team.update({
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
      return tx.team.findUniqueOrThrow({ where: { id: team.id }, select: TEAM_SELECT });
    });
    return toView(row);
  }
}

function sameSet(a: DivisionSet, b: DivisionSet): boolean {
  if (a.allDivisions || b.allDivisions) return a.allDivisions === b.allDivisions;
  return a.divisionIds.length === b.divisionIds.length && a.divisionIds.every((d) => b.divisionIds.includes(d));
}
