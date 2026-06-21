import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { PUBSUB_PORT } from './pubsub.port';
import { InProcessPubSub } from './in-process-pubsub.adapter';

/**
 * Notifications (Slice 6). Binds the v1 in-process {@link PubSubPort} adapter, exposes
 * {@link NotificationsService} to the domain modules that emit events (tasks,
 * submissions, messages), and serves the SSE stream + read/mark-read endpoints.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: PUBSUB_PORT, useClass: InProcessPubSub },
  ],
  exports: [NotificationsService, PUBSUB_PORT],
})
export class NotificationsModule {}
