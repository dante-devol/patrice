import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, QuestionType, StatusCache } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { computeStatusCache } from './task-status';
import {
  ChangeRequesterDto,
  CreateTaskDto,
  ListTasksQuery,
  ManageClaimsDto,
  UpdateTaskDto,
} from './tasks.dto';

export interface TaskView {
  id: string;
  name: string;
  description: string;
  divisionId: string;
  teamId: string | null;
  requesterUserId: string;
  openings: number;
  claimsClosed: boolean;
  statusCache: StatusCache | null;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskListResult {
  items: TaskView[];
  /** Keyset cursor for the next page (the last item's id), or null at the end. */
  nextCursor: string | null;
}

/**
 * Tasks (Slice 4.1). Creation **deep-copies** the division's default questionnaire
 * into a fresh `questionnaire` row owned by the new task (own copy → editing the
 * division default later never mutates this task). Listing is keyset/cursor paginated
 * (newest-first by the UUIDv7 PK) with index-backed faceted filters. PATCH is pure
 * metadata; lifecycle/authority/structure moves go through named action endpoints.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private toView(t: {
    id: string;
    name: string;
    description: string;
    divisionId: string;
    teamId: string | null;
    requesterUserId: string;
    openings: number;
    claimsClosed: boolean;
    statusCache: StatusCache | null;
    lifecycleState: LifecycleState;
    retiredAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }): TaskView {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      divisionId: t.divisionId,
      teamId: t.teamId,
      requesterUserId: t.requesterUserId,
      openings: t.openings,
      claimsClosed: t.claimsClosed,
      statusCache: t.statusCache,
      lifecycleState: t.lifecycleState,
      retiredAt: t.retiredAt,
      version: t.version,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  async get(id: string): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    return this.toView(task);
  }

  /**
   * Create a task and deep-copy the division's questionnaire into a task-owned row.
   * Requires the division to have a questionnaire (else `422 NO_DEFAULT_QUESTIONNAIRE`
   * — the empty `question[]` coordination-only case still counts as "has one").
   * Insertion order is task → questionnaire(owner_task_id) → questions, all in one tx.
   */
  async create(
    organizationId: string,
    actorUserId: string,
    dto: CreateTaskDto,
  ): Promise<TaskView> {
    const division = await this.prisma.division.findFirst({
      where: { id: dto.divisionId, organizationId },
      select: { id: true, lifecycleState: true, defaultOpenings: true },
    });
    if (!division) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }
    if (division.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
    }

    if (dto.teamId) {
      const team = await this.prisma.team.findFirst({
        where: { id: dto.teamId, organizationId },
        select: { id: true, lifecycleState: true },
      });
      if (!team) throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
      if (team.lifecycleState === LifecycleState.retired) {
        throw new ConflictError('TEAM_RETIRED', 'Team is retired');
      }
    }

    // The division MUST have a questionnaire to copy (Slice 4 contract).
    const source = await this.prisma.questionnaire.findUnique({
      where: { ownerDivisionId: dto.divisionId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    if (!source) {
      throw new UnprocessableError(
        'NO_DEFAULT_QUESTIONNAIRE',
        'This division has no questionnaire to copy',
      );
    }

    const statusCache = computeStatusCache({
      activeClaimants: 0,
      openings: division.defaultOpenings,
      claimsClosed: false,
    }) as StatusCache;

    const created = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          organizationId,
          name: dto.name,
          description: dto.description ?? '',
          divisionId: dto.divisionId,
          teamId: dto.teamId ?? null,
          requesterUserId: actorUserId,
          openings: division.defaultOpenings,
          claimsClosed: false,
          statusCache,
        },
      });

      // Deep-copy: a fresh questionnaire row owned by the task, then fresh question
      // rows (new ids) carrying the source's ordinal/type/prompt/required/constraints.
      const questionnaire = await tx.questionnaire.create({
        data: { organizationId, ownerTaskId: task.id },
        select: { id: true },
      });
      if (source.questions.length > 0) {
        await tx.question.createMany({
          data: source.questions.map((q) => ({
            questionnaireId: questionnaire.id,
            ordinal: q.ordinal,
            type: q.type as QuestionType,
            prompt: q.prompt,
            required: q.required,
            constraints: q.constraints as Prisma.InputJsonValue,
          })),
        });
      }

      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.created',
        payload: {
          taskId: task.id,
          divisionId: dto.divisionId,
          teamId: dto.teamId ?? null,
          questionnaireId: questionnaire.id,
        },
      });

      return task;
    });

    return this.toView(created);
  }

  /** Faceted + keyset list (newest-first by UUIDv7 PK; `after` is the last seen id). */
  async list(
    organizationId: string,
    query: ListTasksQuery,
  ): Promise<TaskListResult> {
    const where: Prisma.TaskWhereInput = { organizationId };
    if (query.division) where.divisionId = { in: query.division };
    if (query.team) where.teamId = { in: query.team };
    if (query.status) where.statusCache = { in: query.status as StatusCache[] };
    if (query.requester) where.requesterUserId = { in: query.requester };
    if (query.claimant) {
      // Tasks with at least one ACTIVE (not-left) slot held by a named claimant.
      where.claimants = {
        some: { userId: { in: query.claimant }, leftAt: null },
      };
    }
    // Newer UUIDv7 ids sort greater; newest-first ⇒ desc, cursor ⇒ id < after.
    if (query.after) where.id = { lt: query.after };

    const rows = await this.prisma.task.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: items.map((r) => this.toView(r)),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateTaskDto,
  ): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: task.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.updated',
        payload: { taskId: task.id },
      });
      return row;
    });
    return this.toView(updated);
  }

  async retire(id: string, actorUserId: string): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { id: true, organizationId: true, lifecycleState: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Task is already retired');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: task.id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.retired',
        payload: { taskId: task.id },
      });
      return row;
    });
    return this.toView(updated);
  }

  /**
   * Recompute and persist `status_cache` from the task's current openings, closed
   * flag, and active claimant count (Slice 4 subset). Runs inside the caller's tx so
   * the status moves atomically with the claim/leave/openings change that triggered it.
   */
  private async recomputeStatus(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<StatusCache> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { openings: true, claimsClosed: true },
    });
    const activeClaimants = await tx.taskClaimant.count({
      where: { taskId, leftAt: null },
    });
    const status = computeStatusCache({
      activeClaimants,
      openings: task.openings,
      claimsClosed: task.claimsClosed,
    }) as StatusCache;
    await tx.task.update({ where: { id: taskId }, data: { statusCache: status } });
    return status;
  }

  /** Load an active (non-retired) task or throw 404/409. */
  private async loadActiveTask(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        openings: true,
        claimsClosed: true,
        lifecycleState: true,
        divisionId: true,
      },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }
    return task;
  }

  /**
   * Self-claim (`task:assign`). Eligibility is decided by Cedar before this runs; the
   * service only enforces the operational caps: claims not closed and a free opening.
   * Re-claiming after leaving reactivates the same slot row (UNIQUE task_id,user_id).
   */
  async claim(taskId: string, userId: string): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    if (task.claimsClosed) {
      throw new ConflictError('CLAIMS_CLOSED', 'This task is closed to new claims');
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent claims on this task so the capacity check is race-safe.
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;

      const existing = await tx.taskClaimant.findUnique({
        where: { taskId_userId: { taskId, userId } },
        select: { id: true, leftAt: true },
      });
      if (existing && existing.leftAt === null) {
        throw new ConflictError('ALREADY_CLAIMED', 'You already hold a slot');
      }

      const activeCount = await tx.taskClaimant.count({
        where: { taskId, leftAt: null },
      });
      if (activeCount >= task.openings) {
        throw new ConflictError('NO_OPENINGS', 'No openings remain on this task');
      }

      if (existing) {
        await tx.taskClaimant.update({
          where: { id: existing.id },
          data: { leftAt: null, joinedAt: new Date(), hasSubmitted: false },
        });
      } else {
        await tx.taskClaimant.create({ data: { taskId, userId } });
      }

      const status = await this.recomputeStatus(tx, taskId);
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId: userId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.claimed',
        payload: { taskId, userId, statusCache: status },
      });
      const row = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      return this.toView(row);
    });
  }

  /** Leave a claim (`task:assign`, own slot). Frees the slot (no submits in Slice 4). */
  async leave(taskId: string, userId: string): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    return this.prisma.$transaction(async (tx) => {
      const slot = await tx.taskClaimant.findUnique({
        where: { taskId_userId: { taskId, userId } },
        select: { id: true, leftAt: true },
      });
      if (!slot || slot.leftAt !== null) {
        throw new ConflictError('NOT_CLAIMED', 'You do not hold a slot on this task');
      }
      await tx.taskClaimant.update({
        where: { id: slot.id },
        data: { leftAt: new Date() },
      });
      const status = await this.recomputeStatus(tx, taskId);
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId: userId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.left',
        payload: { taskId, userId, statusCache: status },
      });
      const row = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      return this.toView(row);
    });
  }

  /**
   * Requester claim management (`task:manage_claims`): change the opening count
   * and/or close the task to new claims. Adding openings is blocked when the division
   * has `openings_locked`. Openings may not drop below the active claimant count.
   */
  async manageClaims(
    taskId: string,
    actorUserId: string,
    dto: ManageClaimsDto,
  ): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;

      const data: Prisma.TaskUpdateInput = { version: { increment: 1 } };

      if (dto.openingsDelta !== undefined && dto.openingsDelta !== 0) {
        const division = await tx.division.findUniqueOrThrow({
          where: { id: task.divisionId },
          select: { openingsLocked: true },
        });
        if (division.openingsLocked) {
          throw new ConflictError('OPENINGS_LOCKED', 'Openings are locked for this division');
        }
        const activeCount = await tx.taskClaimant.count({
          where: { taskId, leftAt: null },
        });
        const newOpenings = task.openings + dto.openingsDelta;
        if (newOpenings < 0) {
          throw new ConflictError('INVALID_OPENINGS', 'Openings cannot be negative');
        }
        if (newOpenings < activeCount) {
          throw new ConflictError(
            'INVALID_OPENINGS',
            'Openings cannot drop below current claimants',
          );
        }
        data.openings = newOpenings;
      }

      if (dto.claimsClosed !== undefined) {
        data.claimsClosed = dto.claimsClosed;
      }

      await tx.task.update({ where: { id: taskId }, data });
      const status = await this.recomputeStatus(tx, taskId);
      const row = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.claims_updated',
        payload: {
          taskId,
          openings: row.openings,
          claimsClosed: row.claimsClosed,
          statusCache: status,
        },
      });
      return this.toView(row);
    });
  }

  /** Reassign the requester (`task:change_requester`). New requester must be active. */
  async changeRequester(
    taskId: string,
    actorUserId: string,
    dto: ChangeRequesterDto,
  ): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    const newRequester = await this.prisma.appUser.findFirst({
      where: { id: dto.userId, organizationId: task.organizationId },
      select: { id: true, lifecycleState: true },
    });
    if (!newRequester) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    if (newRequester.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('USER_RETIRED', 'User is retired');
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: taskId },
        data: { requesterUserId: dto.userId, version: { increment: 1 } },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.requester_changed',
        payload: { taskId, requesterUserId: dto.userId },
      });
      return this.toView(row);
    });
  }
}
