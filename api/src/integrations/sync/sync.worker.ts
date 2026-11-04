import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobRunner } from '../../queue/job-runner.service';
import { isFloorDue } from '../reconcile-floor';
import { SyncEngine } from './sync-engine';
import { SyncJobData, SyncService } from './sync.service';

/**
 * Worker: runs integration syncs through the provider-neutral SyncEngine, and every
 * 30 minutes enqueues a full sync for each connection the reconcile floor says is due.
 */
@Injectable()
export class SyncWorker implements OnModuleInit {
  private readonly logger = new Logger(SyncWorker.name);

  constructor(
    private readonly runner: JobRunner,
    private readonly engine: SyncEngine,
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.runner.register('integration.sync', async (data) => {
      const { connectionId, externalUserId } = data as SyncJobData;
      if (externalUserId) await this.engine.syncUser(connectionId, externalUserId);
      else await this.engine.sync(connectionId);
    });
    this.runner.register('integration.reconcile-floor', () => this.floorTick());
    this.runner.schedule('integration.reconcile-floor', '*/30 * * * *');
  }

  async floorTick(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { lifecycleState: LifecycleState.active },
      select: { id: true, lastSyncAt: true },
    });
    for (const c of connections) {
      if (!isFloorDue(c.lastSyncAt)) continue;
      this.logger.log(`Reconcile floor: syncing ${c.id}`);
      await this.sync.enqueue(c.id);
    }
  }
}
