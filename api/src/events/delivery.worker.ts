import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRunner } from '../queue/job-runner.service';
import { EventStore } from './event-store.service';

/**
 * Worker: delivers notifications for events whose post-commit delivery was
 * interrupted. Delivery is idempotent, so running it every minute is safe.
 */
@Injectable()
export class DeliveryWorker implements OnModuleInit {
  constructor(
    private readonly runner: JobRunner,
    private readonly events: EventStore,
  ) {}

  onModuleInit(): void {
    this.runner.register('events.deliver', async () => {
      await this.events.deliver();
    });
    this.runner.schedule('events.deliver', '* * * * *');
  }
}
