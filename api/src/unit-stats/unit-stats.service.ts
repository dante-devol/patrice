import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, StatusCache, TaskState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { VisibilityService } from '../access/visibility.service';
import { ACTIONS } from '../access/actions';
import { taskRef } from '../access/entity-loader';
import { NotFoundError } from '../common/errors';

export type UnitType = 'division' | 'team';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_WEEKS = 12;
/** Upper bound on the rows a stats call reads; past it the stats say they're partial. */
const MAX_TASKS = 5000;

export const TASK_STATES: readonly TaskState[] = ['open', 'claimed', 'review', 'revising', 'approved', 'done', 'retired'];

export interface UnitStatsQuery {
  from?: Date;
  to?: Date;
  team?: string[];
  claimant?: string[];
  requester?: string[];
}

export interface UnitStats {
  from: Date;
  to: Date;
  /** True when the unit had more visible tasks than one call reads. */
  truncated: boolean;
  /** Active, not-completed tasks by status. */
  byStatus: Record<StatusCache, number>;
  completed: number;
  retired: number;
  /**
   * How many tasks were in each state at each point: weekly from `from`, ending at
   * `to`. Tasks created after a point aren't counted at it.
   */
  series: { at: Date; counts: Record<TaskState, number> }[];
  /** Over tasks completed in the range. */
  medianDaysToComplete: number | null;
  /** Over open and claimed tasks now. */
  openAge: { medianDays: number | null; oldestDays: number | null };
  /** Submission to review, over reviews in the range. */
  medianReviewDays: number | null;
  /** Division only: open and completed counts per team. */
  teams?: { teamId: string; name: string; open: number; completed: number }[];
}

const STATS_SELECT = {
  id: true,
  divisionId: true,
  teamId: true,
  requesterUserId: true,
  statusCache: true,
  lifecycleState: true,
  createdAt: true,
  completedAt: true,
  division: { select: { restrictClaims: true } },
  team: { select: { restrictClaims: true } },
  claimants: { where: { leftAt: null }, select: { userId: true } },
} satisfies Prisma.TaskSelect;

/**
 * Stats for a division or team page, computed over the tasks the caller can see
 * there (the task list's pre-filter plus a Cedar `task:read` check on each row), so
 * the numbers never reveal hidden work. A division's stats include the teams that support it. The
 * team, claimant and requester filters narrow every number in the response.
 */
@Injectable()
export class UnitStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly visibility: VisibilityService,
  ) {}

  async stats(unitType: UnitType, unitId: string, userId: string, query: UnitStatsQuery): Promise<UnitStats> {
    await this.assertUnit(unitType, unitId);
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - DEFAULT_WEEKS * WEEK_MS);

    const visible = await this.visibility.taskWhere(userId, ACTIONS.taskRead.action);
    const where: Prisma.TaskWhereInput = {
      ...(unitType === 'division' ? { divisionId: unitId } : { teamId: unitId }),
      ...(visible ? { AND: [visible] } : {}),
    };
    if (query.team && unitType === 'division') where.teamId = { in: query.team };
    if (query.requester) where.requesterUserId = { in: query.requester };
    if (query.claimant) where.claimants = { some: { userId: { in: query.claimant }, leftAt: null } };

    const rows = await this.prisma.task.findMany({ where, select: STATS_SELECT, orderBy: { id: 'desc' }, take: MAX_TASKS + 1 });
    const truncated = rows.length > MAX_TASKS;
    const tasks = await this.access.filterAllowed(userId, ACTIONS.taskRead.action, rows.slice(0, MAX_TASKS), taskRef);

    const byStatus: Record<StatusCache, number> = { open: 0, claimed: 0, review: 0, revising: 0, approved: 0 };
    let completed = 0;
    let retired = 0;
    const inRange = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();
    const toComplete: number[] = [];
    const openAges: number[] = [];
    const now = Date.now();

    for (const t of tasks) {
      if (t.completedAt && inRange(t.completedAt)) {
        toComplete.push((t.completedAt.getTime() - t.createdAt.getTime()) / DAY_MS);
      }
      if (t.lifecycleState === LifecycleState.retired) {
        retired++;
      } else if (t.completedAt) {
        completed++;
      } else {
        byStatus[t.statusCache]++;
        if (t.statusCache === StatusCache.open || t.statusCache === StatusCache.claimed) {
          openAges.push((now - t.createdAt.getTime()) / DAY_MS);
        }
      }
    }

    const taskIds = tasks.map((t) => t.id);
    const [reviews, history] = await Promise.all([
      this.prisma.submission.findMany({
        where: { taskId: { in: taskIds }, reviewedAt: { gte: from, lt: to } },
        select: { submittedAt: true, reviewedAt: true },
      }),
      this.prisma.taskStatusHistory.findMany({
        where: { taskId: { in: taskIds }, changedAt: { lte: to } },
        orderBy: [{ taskId: 'asc' }, { changedAt: 'asc' }],
        select: { taskId: true, state: true, changedAt: true },
      }),
    ]);
    const reviewDays = reviews.map((r) => (r.reviewedAt!.getTime() - r.submittedAt.getTime()) / DAY_MS);

    const result: UnitStats = {
      from,
      to,
      truncated,
      byStatus,
      completed,
      retired,
      series: statusSeries(from, to, history),
      medianDaysToComplete: median(toComplete),
      openAge: { medianDays: median(openAges), oldestDays: openAges.length ? round(Math.max(...openAges)) : null },
      medianReviewDays: median(reviewDays),
    };

    if (unitType === 'division') {
      const teams = await this.prisma.team.findMany({
        where: {
          // Every team that supports the division, all-division teams included. Its
          // numbers count only this division's tasks (the rows are already narrowed).
          OR: [{ allDivisions: true }, { divisions: { some: { divisionId: unitId } } }],
          lifecycleState: LifecycleState.active,
          ...(query.team ? { id: { in: query.team } } : {}),
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      result.teams = teams.map((team) => {
        const mine = tasks.filter((t) => t.teamId === team.id && t.lifecycleState === LifecycleState.active);
        return {
          teamId: team.id,
          name: team.name,
          open: mine.filter((t) => !t.completedAt).length,
          completed: mine.filter((t) => t.completedAt).length,
        };
      });
    }
    return result;
  }

  private async assertUnit(unitType: UnitType, unitId: string): Promise<void> {
    const unit =
      unitType === 'division'
        ? await this.prisma.division.findUnique({ where: { id: unitId }, select: { id: true } })
        : await this.prisma.team.findUnique({ where: { id: unitId }, select: { id: true } });
    if (!unit) {
      throw unitType === 'division'
        ? new NotFoundError('DIVISION_NOT_FOUND', 'Division not found')
        : new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    }
  }
}

/**
 * The state each task was in at each point (weekly from `from`, plus `to`), from its
 * history rows sorted by task then time. A task with no row by a point didn't exist yet.
 */
export function statusSeries(
  from: Date,
  to: Date,
  history: readonly { taskId: string; state: TaskState; changedAt: Date }[],
): UnitStats['series'] {
  const points: Date[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += WEEK_MS) points.push(new Date(t));
  points.push(to);
  const series = points.map((at) => ({ at, counts: emptyCounts() }));

  let i = 0;
  while (i < history.length) {
    const taskId = history[i].taskId;
    let j = i;
    while (j < history.length && history[j].taskId === taskId) j++;
    // Walk the points forward through this task's rows.
    let k = i;
    let state: TaskState | null = null;
    for (const p of series) {
      while (k < j && history[k].changedAt.getTime() <= p.at.getTime()) state = history[k++].state;
      if (state) p.counts[state]++;
    }
    i = j;
  }
  return series;
}

function emptyCounts(): Record<TaskState, number> {
  return { open: 0, claimed: 0, review: 0, revising: 0, approved: 0, done: 0, retired: 0 };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
