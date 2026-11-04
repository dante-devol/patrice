import { Injectable } from '@nestjs/common';
import {
  LifecycleState,
  Prisma,
  StatusCache,
  SubmissionState,
  Task,
  TemplateOrigin,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { EntityLoader, taskRef } from '../access/entity-loader';
import { VisibilityService } from '../access/visibility.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventStore } from '../events/event-store.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { deriveStatus } from './task-status';
import { TaskStatusService } from './task-status.service';
import { RequestTemplatesService } from '../request-templates/request-templates.service';
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
  statusCache: StatusCache;
  templateOrigin: TemplateOrigin;
  sourceTemplateId: string | null;
  completedAt: Date | null;
  completedBy: string | null;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  claimantUserIds: string[];
  /** What the caller may do to this task (on reads only). */
  allowedActions?: string[];
}

/** The actions reported in a task's `allowedActions`. */
export const TASK_VIEW_ACTIONS: readonly string[] = [
  ACTIONS.taskUpdate.action,
  ACTIONS.taskRetire.action,
  ACTIONS.taskRevive.action,
  ACTIONS.taskAssign.action,
  ACTIONS.taskLeave.action,
  ACTIONS.taskSubmit.action,
  ACTIONS.taskReview.action,
  ACTIONS.taskRetireSubmission.action,
  ACTIONS.taskComplete.action,
  ACTIONS.taskManageClaims.action,
  ACTIONS.taskChangeRequester.action,
  ACTIONS.taskConfigureRequestTemplate.action,
  ACTIONS.messageCreate.action,
  ACTIONS.messageRead.action,
  ACTIONS.submissionRead.action,
];

/** The include every task read needs: seated claimants plus claim restrictions. */
const TASK_READ_INCLUDE = {
  claimants: { where: { leftAt: null }, select: { userId: true } },
  division: { select: { restrictClaims: true } },
  team: { select: { restrictClaims: true } },
} as const;

type TaskReadRow = Prisma.TaskGetPayload<{ include: typeof TASK_READ_INCLUDE }>;

export interface TaskListResult {
  items: TaskView[];
  /** Keyset cursor for the next page (the last item's id), or null at the end. */
  nextCursor: string | null;
}

/**
 * Tasks. Creation snapshots the chosen questions onto the task, so editing the source
 * template later never changes it. Listing is keyset paginated (newest first by the
 * UUIDv7 key) with faceted filters. PATCH is pure metadata; everything else goes
 * through named actions. Seats follow the settled slot rules (intent-vs-reality §6.1),
 * and completion is a recorded fact.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly events: EventStore,
    private readonly status: TaskStatusService,
    private readonly grace: GraceService,
    private readonly access: AccessService,
    private readonly visibility: VisibilityService,
    private readonly templates: RequestTemplatesService,
  ) {}

  /** Attach each task's `allowedActions` for `userId`, in one batch of decisions. */
  private async withAllowed(userId: string, rows: TaskReadRow[]): Promise<TaskView[]> {
    const checks = rows.flatMap((r) => {
      const resource = taskRef(r);
      return TASK_VIEW_ACTIONS.map((action) => ({ action, resource }));
    });
    const allowed = await this.access.decideMany(userId, checks);
    return rows.map((r, i) => ({
      ...this.toView(r),
      allowedActions: TASK_VIEW_ACTIONS.filter((_, j) => allowed[i * TASK_VIEW_ACTIONS.length + j]),
    }));
  }

  private toView(t: Task & { claimants?: { userId: string }[] }): TaskView {
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
      templateOrigin: t.templateOrigin,
      sourceTemplateId: t.sourceTemplateId,
      completedAt: t.completedAt,
      completedBy: t.completedBy,
      lifecycleState: t.lifecycleState,
      retiredAt: t.retiredAt,
      version: t.version,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      claimantUserIds: t.claimants?.map((c) => c.userId) ?? [],
    };
  }

  async get(id: string, userId: string): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({ where: { id }, include: TASK_READ_INCLUDE });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    return (await this.withAllowed(userId, [task]))[0];
  }

  /**
   * Create a task in a division with a snapshot of the chosen questions: a library
   * template of that division, its default, or questions the requester writes (which
   * also needs `task:compose_template` on the division).
   */
  async create(actorUserId: string, dto: CreateTaskDto): Promise<TaskView> {
    const division = await this.prisma.division.findFirst({
      where: { id: dto.divisionId },
      select: { id: true, lifecycleState: true, defaultOpenings: true },
    });
    if (!division) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }
    const divisionResource = await new EntityLoader(this.prisma).division(division.id);
    // `task:create` targets the division the task is created in.
    await this.access.assert(actorUserId, ACTIONS.taskCreate.action, divisionResource);
    if (dto.template.kind === 'custom') {
      await this.access.assert(actorUserId, ACTIONS.taskComposeTemplate.action, divisionResource);
    }
    if (division.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
    }

    if (dto.teamId) {
      const team = await this.prisma.team.findFirst({
        where: { id: dto.teamId },
        select: { id: true, lifecycleState: true, divisionId: true },
      });
      if (!team) throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
      if (team.lifecycleState === LifecycleState.retired) {
        throw new ConflictError('TEAM_RETIRED', 'Team is retired');
      }
      if (team.divisionId !== division.id) {
        throw new UnprocessableError('TEAM_NOT_IN_DIVISION', "The team belongs to a different division");
      }
    }

    const template = await this.templates.resolveChoice(division.id, dto.template);
    const statusCache = deriveStatus({
      completed: false,
      openings: division.defaultOpenings,
      claimsClosed: false,
      claimantStates: [],
    }) as StatusCache;

    const created = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          name: dto.name,
          description: dto.description ?? '',
          divisionId: dto.divisionId,
          teamId: dto.teamId ?? null,
          requesterUserId: actorUserId,
          openings: division.defaultOpenings,
          claimsClosed: false,
          statusCache,
          templateOrigin: template.origin,
          sourceTemplateId: template.sourceTemplateId,
        },
      });
      await this.templates.snapshot(tx, task.id, template.questions);

      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.created',
        payload: {
          taskId: task.id,
          divisionId: dto.divisionId,
          teamId: dto.teamId ?? null,
          templateOrigin: template.origin,
          sourceTemplateId: template.sourceTemplateId,
          questionCount: template.questions.length,
        },
      });

      await this.events.record(tx, {
        type: 'task.created',
        taskId: task.id,
        actorUserId,
        payload: { templateOrigin: template.origin, sourceTemplateId: template.sourceTemplateId },
      });
      return task;
    });

    return this.toView(created);
  }

  /**
   * Faceted + keyset list of the tasks the user may see (newest-first by UUIDv7 PK;
   * `after` is the last seen id). A grant-derived predicate narrows the query; Cedar
   * then decides `task:read` on each row, so forbids and the Discord gate apply.
   */
  async list(query: ListTasksQuery, userId: string): Promise<TaskListResult> {
    const visible = await this.visibility.taskWhere(userId, ACTIONS.taskRead.action);
    const where: Prisma.TaskWhereInput = {
      ...activeFilter(query.include === 'retired'),
      ...(visible ? { AND: [visible] } : {}),
    };
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
    let after = query.after;
    const items: TaskReadRow[] = [];
    let exhausted = false;
    // Cedar may drop rows the predicate let through; keep reading until the page is
    // full. Bounded so a user who can see almost nothing can't scan the whole table.
    for (let round = 0; round < 5 && items.length <= query.limit && !exhausted; round++) {
      const batch = await this.prisma.task.findMany({
        where: { ...where, ...(after ? { id: { lt: after } } : {}) },
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        include: TASK_READ_INCLUDE,
      });
      exhausted = batch.length <= query.limit;
      if (batch.length > 0) after = batch[batch.length - 1].id;
      items.push(...(await this.access.filterAllowed(userId, ACTIONS.taskRead.action, batch, taskRef)));
    }
    const hasMore = items.length > query.limit || !exhausted;
    const page = items.slice(0, query.limit);
    return {
      items: await this.withAllowed(userId, page),
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
    };
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateTaskDto,
  ): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: { id: true, lifecycleState: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: task.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          version: { increment: 1 },
        },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.activity.logActivity({
        tx,
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
      select: { id: true, lifecycleState: true },
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
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.retired',
        payload: { taskId: task.id },
      });
      // Active claimants hear the task was retired.
      await this.events.record(tx, {
        type: 'task.retired',
        taskId: task.id,
        actorUserId,
        payload: {},
        notify: { type: 'task.retired', recipients: await this.notifications.activeClaimantIds(tx, task.id) },
      });
      return row;
    });
    await this.events.deliver();
    return this.toView(updated);
  }

  /**
   * Revive a retired task (`task:revive`), the inverse of {@link retire}. Valid only
   * while the task is `retired` AND still inside the grace window (`isRevivable`);
   * otherwise `409 NOT_REVIVABLE` (post-GC the row is gone; pre-retire there is
   * nothing to revive). Cedar gates *who*; the state-machine guard here gates *whether*.
   */
  async revive(id: string, actorUserId: string): Promise<TaskView> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        lifecycleState: true,
        retiredAt: true,
      },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    const graceMs = await this.grace.windowMs();
    if (!isRevivable(task, graceMs)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Task is not retired or its grace period has elapsed',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: task.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.revived',
        payload: { taskId: task.id },
      });
      await this.events.record(tx, { type: 'task.revived', taskId: task.id, actorUserId, payload: {} });
      return row;
    });
    return this.toView(updated);
  }

  /**
   * Recompute and persist `status_cache` via the full Status Min-Rule,
   * which also accounts for claimant submissions. Runs inside the caller's tx so the
   * status moves atomically with the claim/leave/openings change that triggered it.
   */
  private recomputeStatus(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<StatusCache> {
    return this.status.recompute(tx, taskId);
  }

  /** Load an active (non-retired) task or throw 404/409. */
  private async loadActiveTask(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        openings: true,
        claimsClosed: true,
        lifecycleState: true,
        divisionId: true,
        completedAt: true,
      },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }
    return task;
  }

  /** Completion is terminal: claims, openings and submissions stop with it. */
  private assertNotCompleted(task: { completedAt: Date | null }): void {
    if (task.completedAt) throw new ConflictError('TASK_COMPLETED', 'The task is complete');
  }

  /** The claimant's live submissions since they took their seat. */
  private tenureSubmissions(tx: Prisma.TransactionClient, taskId: string, userId: string, joinedAt: Date) {
    return tx.submission.findMany({
      where: {
        taskId,
        claimantUserId: userId,
        lifecycleState: LifecycleState.active,
        submittedAt: { gte: joinedAt },
      },
      select: { id: true, state: true },
    });
  }

  /**
   * Self-claim (`task:assign`). Eligibility is decided by Cedar before this runs; the
   * service only enforces the operational caps: claims not closed and a free opening.
   * Re-claiming after leaving reactivates the same slot row (UNIQUE task_id,user_id).
   */
  async claim(taskId: string, userId: string): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    this.assertNotCompleted(task);
    if (task.claimsClosed) {
      throw new ConflictError('CLAIMS_CLOSED', 'This task is closed to new claims');
    }

    const view = await this.prisma.$transaction(async (tx) => {
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
        actorUserId: userId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.claimed',
        payload: { taskId, userId, statusCache: status },
      });
      await this.events.record(tx, {
        type: 'task.claimed',
        taskId,
        actorUserId: userId,
        payload: { userId },
        notify: { type: 'task.claim_joined', recipients: [await this.notifications.requesterId(tx, taskId)] },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }

  /**
   * Give up your seat (`task:leave`). Only before your first submission: afterwards,
   * withdrawing is the requester's call (they retire the submission).
   */
  async leave(taskId: string, userId: string): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    const view = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
      const slot = await tx.taskClaimant.findUnique({
        where: { taskId_userId: { taskId, userId } },
        select: { id: true, leftAt: true, joinedAt: true },
      });
      if (!slot || slot.leftAt !== null) {
        throw new ConflictError('NOT_CLAIMED', 'You do not hold a slot on this task');
      }
      if ((await this.tenureSubmissions(tx, taskId, userId, slot.joinedAt)).length > 0) {
        throw new ConflictError(
          'SUBMITTED_CANNOT_LEAVE',
          'You cannot leave after submitting; the requester can retire your submission',
        );
      }
      await tx.taskClaimant.update({
        where: { id: slot.id },
        data: { leftAt: new Date() },
      });
      const status = await this.recomputeStatus(tx, taskId);
      await this.activity.logActivity({
        tx,
        actorUserId: userId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.left',
        payload: { taskId, userId, statusCache: status },
      });
      await this.events.record(tx, {
        type: 'task.left',
        taskId,
        actorUserId: userId,
        payload: { userId },
        notify: { type: 'task.claim_left', recipients: [await this.notifications.requesterId(tx, taskId)] },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }

  /**
   * Requester claim management (`task:manage_claims`): change the opening count
   * and/or close the task to new claims. A division's `openings_locked` blocks adding
   * openings, not removing them. Openings stay at least 1 and at least the number of
   * seated claimants.
   */
  async manageClaims(
    taskId: string,
    actorUserId: string,
    dto: ManageClaimsDto,
  ): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    this.assertNotCompleted(task);
    const view = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;

      const data: Prisma.TaskUpdateInput = { version: { increment: 1 } };

      if (dto.openingsDelta !== undefined && dto.openingsDelta !== 0) {
        const division = await tx.division.findUniqueOrThrow({
          where: { id: task.divisionId },
          select: { openingsLocked: true },
        });
        if (division.openingsLocked && dto.openingsDelta > 0) {
          throw new ConflictError('OPENINGS_LOCKED', 'Openings are locked for this division');
        }
        const activeCount = await tx.taskClaimant.count({
          where: { taskId, leftAt: null },
        });
        const newOpenings = task.openings + dto.openingsDelta;
        if (newOpenings < 1) {
          throw new ConflictError('INVALID_OPENINGS', 'A task needs at least one opening');
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
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.activity.logActivity({
        tx,
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
      // Closing claims notifies the active claimants (more openings notify nobody:
      // eligible users discover them on the list).
      await this.events.record(tx, {
        type: 'task.claims_changed',
        taskId,
        actorUserId,
        payload: {
          ...(dto.openingsDelta !== undefined ? { openings: row.openings } : {}),
          ...(dto.claimsClosed !== undefined ? { claimsClosed: row.claimsClosed } : {}),
        },
        ...(dto.claimsClosed === true
          ? { notify: { type: 'task.claims_closed' as const, recipients: await this.notifications.activeClaimantIds(tx, taskId) } }
          : {}),
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }

  /**
   * Complete a task (`task:complete`). Completion is a terminal fact: it closes claims,
   * marks outstanding submissions as no longer required, and makes the task `approved`
   * for good. Seated claimants are notified.
   */
  async complete(taskId: string, actorUserId: string): Promise<TaskView> {
    const task = await this.loadActiveTask(taskId);
    if (task.completedAt) throw new ConflictError('ALREADY_COMPLETED', 'The task is already complete');
    const view = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
      const { count: notRequired } = await tx.submission.updateMany({
        where: {
          taskId,
          lifecycleState: LifecycleState.active,
          state: { in: [SubmissionState.review, SubmissionState.revising] },
        },
        data: { state: SubmissionState.not_required, version: { increment: 1 } },
      });
      await tx.task.update({
        where: { id: taskId },
        data: {
          completedAt: new Date(),
          completedBy: actorUserId,
          claimsClosed: true,
          version: { increment: 1 },
        },
      });
      const status = await this.recomputeStatus(tx, taskId);
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.completed',
        payload: { taskId, statusCache: status, submissionsNotRequired: notRequired },
      });
      await this.events.record(tx, {
        type: 'task.completed',
        taskId,
        actorUserId,
        payload: {},
        notify: { type: 'task.completed', recipients: await this.notifications.activeClaimantIds(tx, taskId) },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }

  /**
   * Evict a claimant (`task:manage_claims`). Always allowed. Their submissions from
   * this tenure stay as a record but are treated as rejected (no resubmission, out of
   * the roll-up); the seat opens, and the evicted user is told.
   */
  async removeClaimant(
    taskId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    const view = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
      const slot = await tx.taskClaimant.findUnique({
        where: { taskId_userId: { taskId, userId: targetUserId } },
        select: { id: true, leftAt: true, joinedAt: true },
      });
      if (!slot || slot.leftAt !== null) {
        throw new NotFoundError('CLAIMANT_NOT_FOUND', 'User does not hold a slot on this task');
      }
      const work = await this.tenureSubmissions(tx, taskId, targetUserId, slot.joinedAt);
      const set = work.filter((w) => w.state !== SubmissionState.rejected).map((w) => w.id);
      if (set.length > 0) {
        await tx.submission.updateMany({
          where: { id: { in: set } },
          data: { state: SubmissionState.rejected, version: { increment: 1 } },
        });
      }
      await tx.taskClaimant.update({
        where: { id: slot.id },
        data: { leftAt: new Date() },
      });
      const status = await this.recomputeStatus(tx, taskId);
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.claimant_removed',
        payload: { taskId, removedUserId: targetUserId, statusCache: status, submissionsRejected: set },
      });
      // An eviction, recorded as one, and the evicted user is told (D17).
      await this.events.record(tx, {
        type: 'task.claimant_evicted',
        taskId,
        actorUserId,
        payload: { userId: targetUserId, submissionIds: set },
        notify: { type: 'task.claim_evicted', recipients: [targetUserId] },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }

  /** Reassign the requester (`task:change_requester`). New requester must be active. */
  async changeRequester(
    taskId: string,
    actorUserId: string,
    dto: ChangeRequesterDto,
  ): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    const newRequester = await this.prisma.appUser.findFirst({
      where: { id: dto.userId },
      select: { id: true, lifecycleState: true },
    });
    if (!newRequester) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    if (newRequester.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('USER_RETIRED', 'User is retired');
    }

    const view = await this.prisma.$transaction(async (tx) => {
      // Capture the outgoing requester before the swap (a notification recipient).
      const oldRequesterId = await this.notifications.requesterId(tx, taskId);
      const row = await tx.task.update({
        where: { id: taskId },
        data: { requesterUserId: dto.userId, version: { increment: 1 } },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.requester_changed',
        payload: { taskId, requesterUserId: dto.userId },
      });
      // Both the outgoing and incoming requester hear about it.
      await this.events.record(tx, {
        type: 'task.requester_changed',
        taskId,
        actorUserId,
        payload: { fromUserId: oldRequesterId, toUserId: dto.userId },
        notify: { type: 'task.requester_changed', recipients: [oldRequesterId, dto.userId] },
      });
      return this.toView(row);
    });
    await this.events.deliver();
    return view;
  }
}
