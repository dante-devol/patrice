import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, StatusCache } from '@prisma/client';
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

export interface UnitStatsQuery {
  from?: Date;
  to?: Date;
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
  /** One entry per week from `from`, by week start. */
  weekly: { weekStart: Date; created: number; completed: number }[];
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
 * the numbers never reveal hidden work. A division's stats include its teams.
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
    const rows = await this.prisma.task.findMany({ where, select: STATS_SELECT, orderBy: { id: 'desc' }, take: MAX_TASKS + 1 });
    const truncated = rows.length > MAX_TASKS;
    const tasks = await this.access.filterAllowed(userId, ACTIONS.taskRead.action, rows.slice(0, MAX_TASKS), taskRef);

    const byStatus: Record<StatusCache, number> = { open: 0, claimed: 0, review: 0, revising: 0, approved: 0 };
    let completed = 0;
    let retired = 0;
    const weeks = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / WEEK_MS));
    const weekly = Array.from({ length: weeks }, (_, i) => ({
      weekStart: new Date(from.getTime() + i * WEEK_MS),
      created: 0,
      completed: 0,
    }));
    const weekOf = (d: Date) => {
      const t = d.getTime();
      if (t < from.getTime() || t >= to.getTime()) return null;
      return weekly[Math.floor((t - from.getTime()) / WEEK_MS)] ?? null;
    };
    const toComplete: number[] = [];
    const openAges: number[] = [];
    const now = Date.now();

    for (const t of tasks) {
      const createdWeek = weekOf(t.createdAt);
      if (createdWeek) createdWeek.created++;
      if (t.completedAt) {
        const doneWeek = weekOf(t.completedAt);
        if (doneWeek) {
          doneWeek.completed++;
          toComplete.push((t.completedAt.getTime() - t.createdAt.getTime()) / DAY_MS);
        }
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

    const reviews = await this.prisma.submission.findMany({
      where: { taskId: { in: tasks.map((t) => t.id) }, reviewedAt: { gte: from, lt: to } },
      select: { submittedAt: true, reviewedAt: true },
    });
    const reviewDays = reviews.map((r) => (r.reviewedAt!.getTime() - r.submittedAt.getTime()) / DAY_MS);

    const result: UnitStats = {
      from,
      to,
      truncated,
      byStatus,
      completed,
      retired,
      weekly,
      medianDaysToComplete: median(toComplete),
      openAge: { medianDays: median(openAges), oldestDays: openAges.length ? round(Math.max(...openAges)) : null },
      medianReviewDays: median(reviewDays),
    };

    if (unitType === 'division') {
      const teams = await this.prisma.team.findMany({
        where: { divisionId: unitId, lifecycleState: LifecycleState.active },
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

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}
