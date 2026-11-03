import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface NotificationView {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationListResult {
  items: NotificationView[];
  unreadCount: number;
  nextCursor: string | null;
}

/**
 * Notifications: the read side, plus the recipient resolvers commands use to decide
 * who an event notifies (snapshotted on the event, see EventStore). Writing the rows
 * and pinging live streams is the EventStore's delivery projection.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Recipient resolvers (the matrix, against live in-tx data) ---------------

  /** The task's current requester. */
  async requesterId(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<string> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { requesterUserId: true },
    });
    return task.requesterUserId;
  }

  /** Users holding an active (not-left) slot on the task. */
  async activeClaimantIds(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<string[]> {
    const slots = await tx.taskClaimant.findMany({
      where: { taskId, leftAt: null },
      select: { userId: true },
    });
    return slots.map((s) => s.userId);
  }

  /** Every user who has ever held a slot on the task (active or departed). */
  async allClaimantIds(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<string[]> {
    const slots = await tx.taskClaimant.findMany({
      where: { taskId },
      select: { userId: true },
    });
    return slots.map((s) => s.userId);
  }

  /**
   * The distinct authors of a thread: the top-level message's sender plus every
   * sender of a reply under it. System (senderless) messages contribute nothing.
   */
  async threadParticipantIds(
    tx: Prisma.TransactionClient,
    topLevelMessageId: string,
  ): Promise<string[]> {
    const rows = await tx.message.findMany({
      where: {
        OR: [{ id: topLevelMessageId }, { parentMessageId: topLevelMessageId }],
        senderUserId: { not: null },
      },
      select: { senderUserId: true },
    });
    return rows.map((r) => r.senderUserId as string);
  }

  // --- Read side ---------------------------------------------------------------

  /**
   * A user's durable notifications, unread-first then newest-first, keyset-paginated
   * by `after` (the last seen id). `unreadCount` is the badge source of truth.
   */
  /**
   * The user's notifications, unread first, then newest. The cursor carries both
   * sort keys (`unread|read` and the id), so paging never skips the read
   * notifications newer than the last unread one.
   */
  async listForUser(
    userId: string,
    opts: { after?: string; limit: number },
  ): Promise<NotificationListResult> {
    const where: Prisma.NotificationWhereInput = { recipientUserId: userId };
    if (opts.after) {
      const [section, id] = opts.after.split(':');
      where.OR =
        section === 'unread'
          ? [{ readAt: null, id: { lt: id } }, { readAt: { not: null } }]
          : [{ readAt: { not: null }, id: { lt: id } }];
    }

    const rows = await this.prisma.notification.findMany({
      where,
      // Unread first, then newest. UUIDv7 ids sort by creation time, so id desc ≈ newest.
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { id: 'desc' }],
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map((r) => this.toView(r)),
      unreadCount: await this.unreadCount(userId),
      nextCursor: hasMore ? `${last.readAt ? 'read' : 'unread'}:${last.id}` : null,
    };
  }

  async markRead(userId: string, id: string): Promise<{ unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { unreadCount: await this.unreadCount(userId) };
  }

  /** Mark every unread notification for the user read. */
  async markAllRead(userId: string): Promise<{ unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { unreadCount: await this.unreadCount(userId) };
  }

  private unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserId: userId, readAt: null },
    });
  }

  private toView(r: {
    id: string;
    type: string;
    subjectType: string;
    subjectId: string;
    payload: unknown;
    readAt: Date | null;
    createdAt: Date;
  }): NotificationView {
    return {
      id: r.id,
      type: r.type,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      payload: r.payload,
      readAt: r.readAt,
      createdAt: r.createdAt,
    };
  }
}
