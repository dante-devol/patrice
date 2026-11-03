import { Inject, Injectable, Logger } from '@nestjs/common';
import { LifecycleState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EventStore } from '../events/event-store.service';
import { NotificationType } from '../notifications/notification.types';
import { STORAGE_PORT, StoragePort } from '../storage/storage.port';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
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
  senderUserId: string | null;
  parentMessageId: string | null;
  /** The submission this comment is about, if any. */
  submissionId: string | null;
  body: string;
  /** Set on a deleted message kept as a marker because it has replies. */
  deletedAt: Date | null;
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
 * A task's thread: comments, one level of replies, optionally about a submission.
 * What *happened* on the task (claims, submissions, reviews) is its timeline, a
 * separate stream of typed events (EventStore); the thread is only what people wrote.
 *
 * Deleting is permanent (with an audit row). A deleted comment that has replies stays
 * as an empty marker so the replies keep their place.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly events: EventStore,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
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
      senderUserId: m.senderUserId,
      parentMessageId: m.parentMessageId,
      submissionId: m.submissionId,
      body: m.body,
      deletedAt: m.deletedAt,
      editedAt: m.editedAt,
      version: m.version,
      createdAt: m.createdAt,
      attachments: m.attachments.map((a) => this.attView(a)),
      ...(m.replies ? { replies: m.replies.map((r) => this.toView(r)) } : {}),
    };
  }

  private async loadActiveTask(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, lifecycleState: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }
    return task;
  }

  async create(taskId: string, actorUserId: string, dto: CreateMessageDto): Promise<MessageView> {
    await this.loadActiveTask(taskId);

    let parent: { id: string; submissionId: string | null } | null = null;
    if (dto.parentMessageId) {
      const found = await this.prisma.message.findUnique({
        where: { id: dto.parentMessageId },
        select: { id: true, taskId: true, parentMessageId: true, submissionId: true, deletedAt: true },
      });
      if (!found || found.taskId !== taskId) {
        throw new NotFoundError('PARENT_NOT_FOUND', 'Parent message not found on this task');
      }
      // One level deep: a reply may only attach to a TOP-LEVEL message.
      if (found.parentMessageId !== null) {
        throw new UnprocessableError('REPLY_TO_REPLY', 'Replies are one level deep; cannot reply to a reply');
      }
      parent = { id: found.id, submissionId: found.submissionId };
    }
    // A reply is about whatever its parent is about.
    const submissionId = parent ? parent.submissionId : (dto.submissionId ?? null);
    if (submissionId && !parent) {
      const submission = await this.prisma.submission.findUnique({
        where: { id: submissionId },
        select: { taskId: true },
      });
      if (!submission || submission.taskId !== taskId) {
        throw new NotFoundError('SUBMISSION_NOT_FOUND', 'Submission not found on this task');
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          taskId,
          senderUserId: actorUserId,
          parentMessageId: parent?.id ?? null,
          submissionId,
          body: dto.body,
        },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'message',
        subjectId: message.id,
        verb: 'message.created',
        payload: { messageId: message.id, taskId, parentMessageId: parent?.id ?? null },
      });
      await this.recordForNotification(tx, { taskId, messageId: message.id, actorUserId, parent, submissionId });
      return message;
    });
    await this.events.deliver();
    return this.toView(created);
  }

  /**
   * Who a new comment notifies:
   *  - about a submission (`message.submission_thread_replied`) → its author + the requester
   *  - a reply (`message.replied`) → the thread's earlier participants
   *  - otherwise (`message.posted`) → the requester + active claimants
   */
  private async recordForNotification(
    tx: Prisma.TransactionClient,
    ctx: {
      taskId: string;
      messageId: string;
      actorUserId: string;
      parent: { id: string } | null;
      submissionId: string | null;
    },
  ): Promise<void> {
    const requester = await this.notifications.requesterId(tx, ctx.taskId);
    let notifyType: NotificationType;
    let recipients: string[];
    if (ctx.submissionId) {
      const submission = await tx.submission.findUnique({
        where: { id: ctx.submissionId },
        select: { claimantUserId: true },
      });
      notifyType = 'message.submission_thread_replied';
      recipients = [submission?.claimantUserId, requester].filter((x): x is string => !!x);
    } else if (ctx.parent) {
      notifyType = 'message.replied';
      recipients = await this.notifications.threadParticipantIds(tx, ctx.parent.id);
    } else {
      notifyType = 'message.posted';
      recipients = [requester, ...(await this.notifications.activeClaimantIds(tx, ctx.taskId))];
    }
    const notify = { type: notifyType, recipients };
    if (ctx.parent) {
      await this.events.record(tx, {
        type: 'message.replied',
        taskId: ctx.taskId,
        actorUserId: ctx.actorUserId,
        payload: { messageId: ctx.messageId, parentMessageId: ctx.parent.id },
        notify,
      });
    } else {
      await this.events.record(tx, {
        type: 'message.posted',
        taskId: ctx.taskId,
        actorUserId: ctx.actorUserId,
        payload: { messageId: ctx.messageId, ...(ctx.submissionId ? { submissionId: ctx.submissionId } : {}) },
        notify,
      });
    }
  }

  /**
   * Top-level messages (oldest-first) with their one-level replies and attachments.
   * A retired task's thread stays readable through its grace period.
   */
  async listForTask(taskId: string, query: ListMessagesQuery): Promise<MessageListResult> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
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

  private async loadLive(id: string) {
    const message = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, taskId: true, deletedAt: true },
    });
    if (!message || message.deletedAt) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
    await this.loadActiveTask(message.taskId);
    return message;
  }

  async update(id: string, actorUserId: string, dto: UpdateMessageDto): Promise<MessageView> {
    const message = await this.loadLive(id);
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.message.update({
        where: { id },
        data: { body: dto.body, editedAt: new Date(), version: { increment: 1 } },
        include: { attachments: true },
      });
      await this.activity.logActivity({
        tx,
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

  /**
   * Delete a message and its files permanently. With replies it stays as an empty
   * marker; otherwise the row goes too.
   */
  async delete(id: string, actorUserId: string): Promise<void> {
    const message = await this.loadLive(id);
    const blobs = await this.prisma.$transaction(async (tx) => {
      const attachments = await tx.attachment.findMany({ where: { messageId: id }, select: { storageKey: true } });
      await tx.attachment.deleteMany({ where: { messageId: id } });
      const replies = await tx.message.count({ where: { parentMessageId: id } });
      if (replies > 0) {
        await tx.message.update({
          where: { id },
          data: { body: '', deletedAt: new Date(), version: { increment: 1 } },
        });
      } else {
        await tx.message.delete({ where: { id } });
      }
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'message',
        subjectId: id,
        verb: 'message.deleted',
        payload: { messageId: id, taskId: message.taskId, keptAsMarker: replies > 0 },
      });
      return attachments.map((a) => a.storageKey);
    });
    // Blobs go after commit; one left behind is collected by the GC's blob reconcile.
    for (const key of blobs) {
      await this.storage.delete(key).catch((e) =>
        this.logger.warn(`Blob delete failed for ${key}: ${(e as Error).message}`),
      );
    }
  }
}
