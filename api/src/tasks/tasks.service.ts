import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, QuestionType, StatusCache } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { EntityLoader, taskRef } from '../access/entity-loader';
import { VisibilityService } from '../access/visibility.service';
import { ActivityService } from '../activity/activity.service';
import { MessagesService } from '../messages/messages.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { computeStatusCache } from './task-status';
import { TaskStatusService } from './task-status.service';
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
  statusCache: StatusCache | null;
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
 * Tasks (Slice 4.1). Creation **deep-copies** the division's default request template
 * into a fresh `request_template` row owned by the new task (own copy → editing the
 * division default later never mutates this task). Listing is keyset/cursor paginated
 * (newest-first by the UUIDv7 PK) with index-backed faceted filters. PATCH is pure
 * metadata; lifecycle/authority/structure moves go through named action endpoints.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly messages: MessagesService,
    private readonly notifications: NotificationsService,
    private readonly status: TaskStatusService,
    private readonly grace: GraceService,
    private readonly access: AccessService,
    private readonly visibility: VisibilityService,
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

  private toView(t: {
    id: string;
    name: string;
    description: string;
    divisionId: string;
    teamId: string | null;
    requesterUserId: string;
    openings: number;
    statusCache: StatusCache | null;
    lifecycleState: LifecycleState;
    retiredAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    claimants?: { userId: string }[];
  }): TaskView {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      divisionId: t.divisionId,
      teamId: t.teamId,
      requesterUserId: t.requesterUserId,
      openings: t.openings,
      statusCache: t.statusCache,
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
   * Create a task and deep-copy the division's request template into a task-owned row.
   * Requires the division to have a request template (else `422 NO_DEFAULT_REQUEST_TEMPLATE`
   * — the empty `question[]` coordination-only case still counts as "has one").
   * Insertion order is task → request_template(owner_task_id) → questions, all in one tx.
   */
  async create(
    actorUserId: string,
    dto: CreateTaskDto,
  ): Promise<TaskView> {
    const division = await this.prisma.division.findFirst({
      where: { id: dto.divisionId },
      select: { id: true, lifecycleState: true, defaultOpenings: true },
    });
    if (!division) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }
    // `task:create` targets the division the task is created in.
    await this.access.assert(
      actorUserId,
      ACTIONS.taskCreate.action,
      await new EntityLoader(this.prisma).division(division.id),
    );
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

    // The division MUST have a request template to copy (Slice 4 contract).
    const source = await this.prisma.requestTemplate.findUnique({
      where: { ownerDivisionId: dto.divisionId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    if (!source) {
      throw new UnprocessableError(
        'NO_DEFAULT_REQUEST_TEMPLATE',
        'This division has no request template to copy',
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

      // Deep-copy: a fresh request template row owned by the task, then fresh question
      // rows (new ids) carrying the source's ordinal/type/prompt/required/constraints.
      const requestTemplate = await tx.requestTemplate.create({
        data: { ownerTaskId: task.id },
        select: { id: true },
      });
      if (source.questions.length > 0) {
        await tx.question.createMany({
          data: source.questions.map((q) => ({
            requestTemplateId: requestTemplate.id,
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
        actorUserId,
        subjectType: 'task',
        subjectId: task.id,
        verb: 'task.created',
        payload: {
          taskId: task.id,
          divisionId: dto.divisionId,
          teamId: dto.teamId ?? null,
          requestTemplateId: requestTemplate.id,
        },
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
    let notified: string[] = [];
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
      // Active claimants hear the task was retired (the actor — usually the requester
      // — is suppressed).
      notified = await this.notifications.emit(tx, {
        type: 'task.retired',
        subjectType: 'task',
        subjectId: task.id,
        senderUserId: actorUserId,
        recipientUserIds: await this.notifications.activeClaimantIds(tx, task.id),
        payload: { taskId: task.id },
      });
      return row;
    });
    this.notifications.publish(notified);
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
      return row;
    });
    return this.toView(updated);
  }

  /**
   * Recompute and persist `status_cache` via the full Status Min-Rule (Slice 5),
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

    let notified: string[] = [];
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
      await this.messages.createSystemMessage(tx, taskId, `User ${userId} claimed this task.`);
      // Notify the requester of the new claim (the claimer is suppressed).
      notified = await this.notifications.emit(tx, {
        type: 'task.claim_joined',
        subjectType: 'task',
        subjectId: taskId,
        senderUserId: userId,
        recipientUserIds: [await this.notifications.requesterId(tx, taskId)],
        payload: { taskId, actorUserId: userId },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    this.notifications.publish(notified);
    return view;
  }

  /** Leave a claim (`task:assign`, own slot). Frees the slot (no submits in Slice 4). */
  async leave(taskId: string, userId: string): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    let notified: string[] = [];
    const view = await this.prisma.$transaction(async (tx) => {
      // Lock the task so the claim_left event_seq computation can't race a sibling.
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
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
        actorUserId: userId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.left',
        payload: { taskId, userId, statusCache: status },
      });
      await this.messages.createSystemMessage(tx, taskId, `User ${userId} left this task.`);
      // Notify the requester that a claimant left (the leaver is suppressed).
      notified = await this.notifications.emit(tx, {
        type: 'task.claim_left',
        subjectType: 'task',
        subjectId: taskId,
        senderUserId: userId,
        recipientUserIds: [await this.notifications.requesterId(tx, taskId)],
        payload: { taskId, actorUserId: userId },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    this.notifications.publish(notified);
    return view;
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
    let notified: string[] = [];
    const view = await this.prisma.$transaction(async (tx) => {
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
      // Closing claims notifies the active claimants (openings_added notifies nobody —
      // eligible users discover it on the list). The actor (requester) is suppressed.
      if (dto.claimsClosed === true) {
        notified = await this.notifications.emit(tx, {
          type: 'task.claims_closed',
          subjectType: 'task',
          subjectId: taskId,
          senderUserId: actorUserId,
          recipientUserIds: await this.notifications.activeClaimantIds(tx, taskId),
          payload: { taskId },
        });
      }
      return this.toView(row);
    });
    this.notifications.publish(notified);
    return view;
  }

  /**
   * Manually complete a task (`task:complete`, the **Manual Complete** bypass): force
   * `status_cache` to `approved` regardless of slot/submission state. Outstanding
   * submissions are left in place (the UI surfaces them as no longer required). Emits a
   * system message + activity row.
   */
  async complete(taskId: string, actorUserId: string): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    let notified: string[] = [];
    const view = await this.prisma.$transaction(async (tx) => {
      const row = await tx.task.update({
        where: { id: taskId },
        data: { statusCache: StatusCache.approved, version: { increment: 1 } },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      await this.messages.createSystemMessage(
        tx,
        taskId,
        `User ${actorUserId} marked this task complete.`,
      );
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task.completed',
        payload: { taskId, statusCache: StatusCache.approved },
      });
      // Notify the active claimants their work is accepted (requester is suppressed).
      notified = await this.notifications.emit(tx, {
        type: 'task.completed',
        subjectType: 'task',
        subjectId: taskId,
        senderUserId: actorUserId,
        recipientUserIds: await this.notifications.activeClaimantIds(tx, taskId),
        payload: { taskId },
      });
      return this.toView(row);
    });
    this.notifications.publish(notified);
    return view;
  }

  /**
   * Admin eviction (`task:manage_claims`): remove a specific claimant from their slot,
   * leaving the opening available for someone else. Mirrors `leave()` but targets any
   * named user rather than the caller themselves.
   */
  async removeClaimant(
    taskId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<TaskView> {
    await this.loadActiveTask(taskId);
    let notified: string[] = [];
    const view = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
      const slot = await tx.taskClaimant.findUnique({
        where: { taskId_userId: { taskId, userId: targetUserId } },
        select: { id: true, leftAt: true },
      });
      if (!slot || slot.leftAt !== null) {
        throw new NotFoundError('CLAIMANT_NOT_FOUND', 'User does not hold a slot on this task');
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
        payload: { taskId, removedUserId: targetUserId, statusCache: status },
      });
      await this.messages.createSystemMessage(tx, taskId, `User ${targetUserId} left this task.`);
      notified = await this.notifications.emit(tx, {
        type: 'task.claim_left',
        subjectType: 'task',
        subjectId: taskId,
        senderUserId: actorUserId,
        recipientUserIds: [await this.notifications.requesterId(tx, taskId)],
        payload: { taskId, actorUserId: targetUserId },
      });
      const row = await tx.task.findUniqueOrThrow({
        where: { id: taskId },
        include: { claimants: { where: { leftAt: null }, select: { userId: true } } },
      });
      return this.toView(row);
    });
    this.notifications.publish(notified);
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

    let notified: string[] = [];
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
      await this.messages.createSystemMessage(
        tx,
        taskId,
        `Requester changed to user ${dto.userId}.`,
      );
      // Both the outgoing and incoming requester hear about it (actor suppressed).
      notified = await this.notifications.emit(tx, {
        type: 'task.requester_changed',
        subjectType: 'task',
        subjectId: taskId,
        senderUserId: actorUserId,
        recipientUserIds: [oldRequesterId, dto.userId],
        payload: { taskId, requesterUserId: dto.userId, actorUserId },
      });
      return this.toView(row);
    });
    this.notifications.publish(notified);
    return view;
  }
}
