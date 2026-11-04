import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRunner } from '../../queue/job-runner.service';
import { SyncJobData, SyncService } from './sync.service';

/** Worker: runs integration syncs, and the reconcile floor every 30 minutes. */
@Injectable()
export class SyncWorker implements OnModuleInit {
  constructor(
    private readonly runner: JobRunner,
    private readonly sync: SyncService,
  ) {}

  onModuleInit(): void {
    this.runner.register('integration.sync', async (data) => {
      const { connectionId, externalUserId } = data as SyncJobData;
      if (externalUserId) await this.sync.runSyncUser(connectionId, externalUserId);
      else await this.sync.runSync(connectionId);
    });
    this.runner.register('integration.reconcile-floor', () => this.sync.reconcileFloorTick());
    this.runner.schedule('integration.reconcile-floor', '*/30 * * * *');
  }
}
