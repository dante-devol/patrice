import { Inject, Injectable } from '@nestjs/common';
import { LifecycleState, MessageKind, Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { isRevivable } from '../common/lifecycle';
import { CreateMessageDto, ListMessagesQuery, UpdateMessageDto } from './messages.dto';

export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  kind: string;
  uploaderUserId: string;
  createdAt: Date;
}

export interface MessageView {
  id: string;
  taskId: string;
  kind: MessageKind;
  senderUserId: string | null;
  parentMessageId: string | null;
  body: string;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  editedAt: Date | null;
  version: number;
  createdAt: Date;
  attachments: AttachmentView[];
  replies?: MessageView[];
}

export interface MessageListResult {
  items: MessageView[];
  nextCursor: string | null;
}

type MessageRow = Prisma.MessageGetPayload<{ include: { attachments: true } }>;

/**
 * Task message threads (Slice 4.3). `comment` messages are user-authored; senderless
 * `system` messages record claim/leave/requester-change events (emitted via
 * {@link createSystemMessage} from the task flows). Threads are one level deep — a
 * reply's parent must be top-level (guarded here; a DB trigger is the backstop).
 */
@Injectable()
export class MessagesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
  ) {}

  private attView(a: MessageRow['attachments'][number]): AttachmentView {
    return {
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      byteSize: Number(a.byteSize),
      kind: a.kind,
      uploaderUserId: a.uploaderUserId,
      createdAt: a.createdAt,
    };
  }

  private toView(m: MessageRow & { replies?: MessageRow[] }): MessageView {
    return {
      id: m.id,
      taskId: m.taskId,
      kind: m.kind,
      senderUserId: m.senderUserId,
      parentMessageId: m.parentMessageId,
      body: m.body,
      lifecycleState: m.lifecycleState,
      retiredAt: m.retiredAt,
      editedAt: m.editedAt,
      version: m.version,
      createdAt: m.createdAt,
      attachments: m.attachments.map((a) => this.attView(a)),
      ...(m.replies
        ? { replies: m.replies.map((r) => this.toView(r)) }
        : {}),
    };
  }

  private async loadActiveTask(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, organizationId: true, lifecycleState: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }
    return task;
  }

  async create(
    taskId: string,
    actorUserId: string,
    dto: CreateMessageDto,
  ): Promise<MessageView> {
    const task = await this.loadActiveTask(taskId);

    let parent: { id: string; submissionId: string | null } | null = null;
    if (dto.parentMessageId) {
      const found = await this.prisma.message.findUnique({
        where: { id: dto.parentMessageId },
        select: { id: true, taskId: true, parentMessageId: true, submissionId: true },
      });
      if (!found || found.taskId !== taskId) {
        throw new NotFoundError('PARENT_NOT_FOUND', 'Parent message not found on this task');
      }
      // One level deep: a reply may only attach to a TOP-LEVEL message.
      if (found.parentMessageId !== null) {
        throw new UnprocessableError(
          'REPLY_TO_REPLY',
          'Replies are one level deep; cannot reply to a reply',
        );
      }
      parent = { id: found.id, submissionId: found.submissionId };
    }

    let notified: string[] = [];
    const created = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          taskId,
          kind: MessageKind.comment,
          senderUserId: actorUserId,
          parentMessageId: dto.parentMessageId ?? null,
          body: dto.body,
        },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'message',
        subjectId: message.id,
        verb: 'message.created',
        payload: {
          messageId: message.id,
          taskId,
          parentMessageId: dto.parentMessageId ?? null,
        },
      });
      notified = await this.notifyMessage(tx, {
        organizationId: task.organizationId,
        taskId,
        messageId: message.id,
        actorUserId,
        parent,
      });
      return message;
    });
    this.notifications.publish(notified);
    return this.toView(created);
  }

  /**
   * Fan a new comment out per the message recipient matrix (Slice 6). The subject is
   * the message id (unique per event ⇒ `event_seq` is always 1, no collision), the
   * sender is suppressed, and the cohort branches on thread shape:
   *
   *  - top-level (`message.posted`) → requester + active claimants
   *  - reply in a submission thread (`message.submission_thread_replied`) → that
   *    submission's claimant + the task requester
   *  - reply in a plain thread (`message.replied`) → the thread's prior participants
   */
  private async notifyMessage(
    tx: Prisma.TransactionClient,
    ctx: {
      organizationId: string;
      taskId: string;
      messageId: string;
      actorUserId: string;
      parent: { id: string; submissionId: string | null } | null;
    },
  ): Promise<string[]> {
    const base = {
      organizationId: ctx.organizationId,
      subjectType: 'message',
      subjectId: ctx.messageId,
      senderUserId: ctx.actorUserId,
      payload: { taskId: ctx.taskId, messageId: ctx.messageId, actorUserId: ctx.actorUserId },
    } as const;

    if (!ctx.parent) {
      const requester = await this.notifications.requesterId(tx, ctx.taskId);
      const claimants = await this.notifications.activeClaimantIds(tx, ctx.taskId);
      return this.notifications.emit(tx, {
        ...base,
        type: 'message.posted',
        recipientUserIds: [requester, ...claimants],
      });
    }

    if (ctx.parent.submissionId) {
      const submission = await tx.submission.findUnique({
        where: { id: ctx.parent.submissionId },
        select: { claimantUserId: true },
      });
      const requester = await this.notifications.requesterId(tx, ctx.taskId);
      return this.notifications.emit(tx, {
        ...base,
        type: 'message.submission_thread_replied',
        recipientUserIds: [submission?.claimantUserId, requester].filter(
          (x): x is string => !!x,
        ),
      });
    }

    return this.notifications.emit(tx, {
      ...base,
      type: 'message.replied',
      recipientUserIds: await this.notifications.threadParticipantIds(tx, ctx.parent.id),
    });
  }

  /**
   * Emit a senderless system message on a task's thread (claim/leave/requester change,
   * and the Slice 5 submission/review events). Runs inside the caller's transaction so
   * it's atomic with the triggering event. Body references the actor by id only — no
   * PII (consistent with audit discipline).
   *
   * `submissionId` hosts the message in a submission's thread (M1 "X submitted v{n}");
   * `parentMessageId` threads a review reply under that top-level message. Returns the
   * created message's id so a caller can thread replies beneath it.
   */
  async createSystemMessage(
    tx: Prisma.TransactionClient,
    taskId: string,
    body: string,
    opts: { submissionId?: string | null; parentMessageId?: string | null } = {},
  ): Promise<string> {
    const message = await tx.message.create({
      data: {
        taskId,
        kind: MessageKind.system,
        senderUserId: null,
        body,
        submissionId: opts.submissionId ?? null,
        parentMessageId: opts.parentMessageId ?? null,
      },
      select: { id: true },
    });
    return message.id;
  }

  /** Top-level messages (oldest-first) with their one-level replies + attachments. */
  async listForTask(
    taskId: string,
    query: ListMessagesQuery,
  ): Promise<MessageListResult> {
    await this.loadActiveTask(taskId);
    const where: Prisma.MessageWhereInput = { taskId, parentMessageId: null };
    if (query.after) where.id = { gt: query.after };

    const rows = await this.prisma.message.findMany({
      where,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      include: {
        attachments: true,
        replies: { orderBy: { id: 'asc' }, include: { attachments: true } },
      },
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
    dto: UpdateMessageDto,
  ): Promise<MessageView> {
    const message = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, taskId: true, lifecycleState: true, task: { select: { organizationId: true } } },
    });
    if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
    if (message.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('MESSAGE_RETIRED', 'Message is retired');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.message.update({
        where: { id },
        data: { body: dto.body, editedAt: new Date(), version: { increment: 1 } },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId: message.task.organizationId,
        actorUserId,
        subjectType: 'message',
        subjectId: id,
        verb: 'message.updated',
        payload: { messageId: id, taskId: message.taskId },
      });
      return row;
    });
    return this.toView(updated);
  }

  async retire(id: string, actorUserId: string): Promise<MessageView> {
    const message = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, taskId: true, lifecycleState: true, task: { select: { organizationId: true } } },
    });
    if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
    if (message.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Message is already retired');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.message.update({
        where: { id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: new Date(),
          version: { increment: 1 },
        },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId: message.task.organizationId,
        actorUserId,
        subjectType: 'message',
        subjectId: id,
        verb: 'message.retired',
        payload: { messageId: id, taskId: message.taskId },
      });
      return row;
    });
    return this.toView(updated);
  }

  /**
   * Revive a retired message (`message:revive`), the inverse of {@link retire}. Valid
   * only while `retired` AND inside the grace window; otherwise `409 NOT_REVIVABLE`.
   */
  async revive(id: string, actorUserId: string): Promise<MessageView> {
    const message = await this.prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        taskId: true,
        lifecycleState: true,
        retiredAt: true,
        task: { select: { organizationId: true } },
      },
    });
    if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
    if (!isRevivable(message, this.env.RETIREMENT_GRACE_DAYS)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Message is not retired or its grace period has elapsed',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.message.update({
        where: { id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId: message.task.organizationId,
        actorUserId,
        subjectType: 'message',
        subjectId: id,
        verb: 'message.revived',
        payload: { messageId: id, taskId: message.taskId },
      });
      return row;
    });
    return this.toView(updated);
  }
}
