import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../queue/queue.service';
import { DiscordAdapter } from './discord.adapter';

const QUEUE_INTEGRATION_SYNC = 'integration-sync';

export interface SyncJobData {
  connectionId: string;
}

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly discord: DiscordAdapter,
  ) {}

  async onModuleInit() {
    await this.queue.work(QUEUE_INTEGRATION_SYNC, async (data) => {
      const job = data as SyncJobData;
      await this.runSync(job.connectionId);
    });
  }

  /** Enqueue a sync run (idempotent per connection via singletonKey). */
  async enqueue(connectionId: string): Promise<void> {
    await this.queue.publish(
      QUEUE_INTEGRATION_SYNC,
      { connectionId } satisfies SyncJobData,
      { singletonKey: `sync-${connectionId}` },
    );
  }

  private async runSync(connectionId: string): Promise<void> {
    try {
      await this.discord.sync(connectionId);
    } catch (err) {
      this.logger.error(`Sync failed for connection ${connectionId}: ${(err as Error).message}`);
    }
  }
}
