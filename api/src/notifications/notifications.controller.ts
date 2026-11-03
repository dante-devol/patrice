import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotificationsService } from './notifications.service';
import { PUBSUB_PORT, PubSubPort } from './pubsub.port';
import {
  listNotificationsQuerySchema,
  type ListNotificationsQuery,
} from './notifications.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/** Keep the SSE connection from idling out behind proxies (also a liveness ping). */
const HEARTBEAT_MS = 25_000;

/**
 * Notification delivery + read endpoints (Slice 6.2). Reads are ungated (§2.3) but
 * scoped to the caller's own rows — every method keys on `req.user.id`. The stream
 * emits thin `sync` pings; the durable rows are always pulled from `GET /notifications`.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(PUBSUB_PORT) private readonly pubsub: PubSubPort,
  ) {}

  /**
   * Per-user SSE stream. Emits an initial `sync` on connect (so the client reconciles
   * immediately) and a further `sync` on every new notification for this user; a
   * periodic `ping` keeps the connection warm. No payload rides the stream.
   */
  @Contract(ROUTES.notificationStream)
  @Sse('stream')
  stream(@CurrentUser() user: CurrentUserRef): Observable<MessageEvent> {
    const userId = user.id;
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ type: 'sync', data: '{}' });
      const unsubscribe = this.pubsub.subscribe(userId, () =>
        subscriber.next({ type: 'sync', data: '{}' }),
      );
      const heartbeat = setInterval(
        () => subscriber.next({ type: 'ping', data: '{}' }),
        HEARTBEAT_MS,
      );
      return () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    });
  }

  /** The caller's durable notifications (unread-first), with the badge `unreadCount`. */
  @Contract(ROUTES.listNotifications)
  @Get()
  list(
    @Query(new ZodValidationPipe(listNotificationsQuerySchema))
    query: ListNotificationsQuery,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.notifications.listForUser(user.id, {
      after: query.after,
      limit: query.limit,
    });
  }

  @Contract(ROUTES.markNotificationRead)
  @Post(':id/read')
  @HttpCode(200)
  markRead(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.notifications.markRead(user.id, id);
  }

  @Contract(ROUTES.markAllNotificationsRead)
  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentUser() user: CurrentUserRef) {
    return this.notifications.markAllRead(user.id);
  }
}
