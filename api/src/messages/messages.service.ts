import { Injectable } from '@nestjs/common';
import { LifecycleState, MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
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
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
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

    if (dto.parentMessageId) {
      const parent = await this.prisma.message.findUnique({
        where: { id: dto.parentMessageId },
        select: { id: true, taskId: true, parentMessageId: true },
      });
      if (!parent || parent.taskId !== taskId) {
        throw new NotFoundError('PARENT_NOT_FOUND', 'Parent message not found on this task');
      }
      // One level deep: a reply may only attach to a TOP-LEVEL message.
      if (parent.parentMessageId !== null) {
        throw new UnprocessableError(
          'REPLY_TO_REPLY',
          'Replies are one level deep; cannot reply to a reply',
        );
      }
    }

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
      return message;
    });
    return this.toView(created);
  }

  /**
   * Emit a senderless system message on a task's thread (claim/leave/requester change).
   * Runs inside the caller's transaction so it's atomic with the triggering event.
   * Body references the actor by id only — no PII (consistent with audit discipline).
   */
  async createSystemMessage(
    tx: Prisma.TransactionClient,
    taskId: string,
    body: string,
  ): Promise<void> {
    await tx.message.create({
      data: { taskId, kind: MessageKind.system, senderUserId: null, body },
    });
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
}
