import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PUBSUB_PORT } from './pubsub.port';
import { InProcessPubSub } from './in-process-pubsub.adapter';

/**
 * Notifications (Slice 6). Binds the v1 in-process {@link PubSubPort} adapter and
 * exposes {@link NotificationsService} to the domain modules that emit events
 * (tasks, submissions, messages). The SSE/read controller lands with Slice 6.2.
 */
@Module({
  providers: [
    NotificationsService,
    { provide: PUBSUB_PORT, useClass: InProcessPubSub },
  ],
  exports: [NotificationsService, PUBSUB_PORT],
})
export class NotificationsModule {}
