import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBSUB_PORT, PubSubPort } from './pubsub.port';
import {
  NotificationEvent,
  computeRecipients,
} from './notification.types';

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
 * Notifications (Slice 6). Two responsibilities, kept apart:
 *
 *  1. **Generate** — {@link emit} inserts one durable row per recipient *inside the
 *     caller's transaction*, snapshotting the cohort + facts into `payload`, with the
 *     sender suppressed. The `UNIQUE(recipient,type,subject,event_seq)` index makes a
 *     retried emit a no-op. Returns the recipients written so the caller can ping.
 *  2. **Deliver** — {@link publish} pushes a thin `sync` ping through the PubSubPort
 *     *after the transaction commits* (so the client's reconcile pull sees the row).
 *     Durability never rides the stream.
 *
 * The recipient resolvers ({@link requesterId}, {@link activeClaimantIds}, …) encode
 * the slice's recipient matrix against live, in-transaction data.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUBSUB_PORT) private readonly pubsub: PubSubPort,
  ) {}

  /**
   * Insert per-recipient rows for one event (idempotent). Runs in the caller's `tx`
   * so it's atomic with the triggering write. Returns the recipient ids written (the
   * cohort minus the sender), for {@link publish} to ping post-commit.
   */
  async emit(
    tx: Prisma.TransactionClient,
    event: NotificationEvent,
  ): Promise<string[]> {
    const recipients = computeRecipients(event.recipientUserIds, event.senderUserId);
    if (recipients.length === 0) return [];

    const eventSeq =
      event.eventSeq ??
      (await this.nextEventSeq(tx, event.subjectType, event.subjectId, event.type));

    await tx.notification.createMany({
      data: recipients.map((recipientUserId) => ({
        organizationId: event.organizationId,
        recipientUserId,
        type: event.type,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        payload: event.payload as Prisma.InputJsonValue,
        eventSeq,
      })),
      // The idempotency guard: a retry carrying the same (recipient,type,subject,seq)
      // collides on the UNIQUE index and is silently skipped.
      skipDuplicates: true,
    });
    return recipients;
  }

  /** Fan a `sync` ping out to each recipient's open streams (post-commit). */
  publish(userIds: readonly string[]): void {
    for (const userId of userIds) {
      this.pubsub.publish(userId, { type: 'sync' });
    }
  }

  /** Next monotonic `event_seq` for this (subject_type, subject_id, type) triple. */
  private async nextEventSeq(
    tx: Prisma.TransactionClient,
    subjectType: string,
    subjectId: string,
    type: string,
  ): Promise<bigint> {
    const agg = await tx.notification.aggregate({
      where: { subjectType, subjectId, type },
      _max: { eventSeq: true },
    });
    return (agg._max.eventSeq ?? 0n) + 1n;
  }

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
  async listForUser(
    userId: string,
    opts: { after?: string; limit: number },
  ): Promise<NotificationListResult> {
    const where: Prisma.NotificationWhereInput = { recipientUserId: userId };
    if (opts.after) where.id = { lt: opts.after };

    const rows = await this.prisma.notification.findMany({
      where,
      // Unread first, then newest. UUIDv7 ids sort by creation time, so id desc ≈ newest.
      orderBy: [{ readAt: { sort: 'asc', nulls: 'first' } }, { id: 'desc' }],
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;

    const unreadCount = await this.prisma.notification.count({
      where: { recipientUserId: userId, readAt: null },
    });

    return {
      items: items.map((r) => this.toView(r)),
      unreadCount,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  /** Mark one notification read (idempotent; only the owner's row is touched). */
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
