import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { PUBSUB_PORT, PubSubPort } from '../notifications/pubsub.port';
import { NotificationType, computeRecipients } from '../notifications/notification.types';
import {
  DomainEventPayload,
  DomainEventType,
  TIMELINE_EVENT_TYPES,
  domainEventPayloadSchemas,
} from './event.types';

const DELIVER_QUEUE = 'events.deliver';
const DELIVER_BATCH = 200;

export interface RecordArgs<T extends DomainEventType> {
  type: T;
  /** Set for events that belong on a task's timeline. */
  taskId?: string | null;
  actorUserId: string | null;
  payload: DomainEventPayload<T>;
  /** Who to notify, and as what. The actor is never notified of their own event. */
  notify?: { type: NotificationType; recipients: readonly (string | null | undefined)[] };
}

/**
 * The domain event stream. Commands `record` events inside their transaction; the
 * timeline reads them back by task, and the notification projection turns each
 * event's snapshotted recipients into notification rows.
 *
 * Delivery runs right after the command commits (`deliver`), and a scheduled job
 * re-runs it so an event whose delivery was interrupted is still delivered. Each
 * notification is unique per (event, recipient), so delivering twice is a no-op.
 */
@Injectable()
export class EventStore implements OnModuleInit {
  private readonly logger = new Logger(EventStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(PUBSUB_PORT) private readonly pubsub: PubSubPort,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.work(DELIVER_QUEUE, () => this.deliver().then(() => undefined));
    await this.queue.schedule(DELIVER_QUEUE, '* * * * *', {}, { singletonKey: DELIVER_QUEUE });
  }

  /** Record an event in the caller's transaction. Returns its id. */
  async record<T extends DomainEventType>(tx: Prisma.TransactionClient, args: RecordArgs<T>): Promise<string> {
    const parsed = domainEventPayloadSchemas[args.type].safeParse(args.payload);
    if (!parsed.success) {
      // A malformed event is a programming error; fail the command rather than
      // recording something the client can't render.
      throw new Error(`Invalid payload for event "${args.type}": ${parsed.error.message}`);
    }
    const recipients = args.notify ? computeRecipients(args.notify.recipients, args.actorUserId) : [];
    const event = await tx.domainEvent.create({
      data: {
        type: args.type,
        taskId: args.taskId ?? null,
        actorUserId: args.actorUserId,
        payload: parsed.data as Prisma.InputJsonValue,
        notifyType: recipients.length > 0 ? args.notify!.type : null,
        recipients,
        // Nothing to deliver: mark it done so the projection never revisits it.
        notifiedAt: recipients.length > 0 ? null : new Date(),
      },
      select: { id: true },
    });
    return event.id;
  }

  /**
   * Write the notifications for every undelivered event, then ping the recipients'
   * live streams. Safe to call concurrently and repeatedly. Returns the number of
   * events delivered.
   */
  async deliver(): Promise<number> {
    const events = await this.prisma.domainEvent.findMany({
      where: { notifiedAt: null },
      orderBy: { occurredAt: 'asc' },
      take: DELIVER_BATCH,
    });
    const pinged = new Set<string>();
    for (const e of events) {
      const subject = e.taskId
        ? { subjectType: 'task', subjectId: e.taskId }
        : { subjectType: 'integration_connection', subjectId: (e.payload as { connectionId: string }).connectionId };
      await this.prisma.$transaction([
        this.prisma.notification.createMany({
          data: e.recipients.map((recipientUserId) => ({
            eventId: e.id,
            recipientUserId,
            type: e.notifyType!,
            ...subject,
            payload: {
              ...(e.payload as Record<string, unknown>),
              ...(e.taskId ? { taskId: e.taskId } : {}),
              actorUserId: e.actorUserId,
            } as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        }),
        this.prisma.domainEvent.update({ where: { id: e.id }, data: { notifiedAt: new Date() } }),
      ]);
      e.recipients.forEach((r) => pinged.add(r));
    }
    for (const userId of pinged) this.pubsub.publish(userId, { type: 'sync' });
    if (events.length === DELIVER_BATCH) this.logger.log('Delivery backlog; the next run continues it');
    return events.length;
  }

  /** A task's timeline, oldest first. */
  async timeline(taskId: string) {
    return this.prisma.domainEvent.findMany({
      where: { taskId, type: { in: [...TIMELINE_EVENT_TYPES] } },
      orderBy: { occurredAt: 'asc' },
      select: { id: true, type: true, actorUserId: true, payload: true, occurredAt: true },
    });
  }
}
