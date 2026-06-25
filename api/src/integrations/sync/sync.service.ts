import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { ENV, Env } from '../../config/env';
import { DiscordAdapter } from './discord.adapter';
import { PROCESS_ROLE, isWorkerRole, type ProcessRoleValue } from '../../common/process-role';

const QUEUE_INTEGRATION_SYNC = 'integration-sync';
const QUEUE_INTEGRATION_SYNC_SCHEDULED = 'integration-sync-scheduled';

export interface SyncJobData {
  connectionId: string;
}

/**
 * pg-boss sync orchestrator (Slice 8.4).
 *
 * Two enqueue paths:
 *  - `enqueue(connectionId)` — immediate, manual trigger or cron.
 *  - `enqueueSoon(connectionId)` — delayed by INTEGRATION_SYNC_DELAY_SECONDS with
 *    singletonKey so rapid role-change bursts collapse into a single run.
 *
 * `notifyRoleChange(roleId)` is called by UsersService after any grant/revoke; it
 * finds every active connection that maps that role and calls `enqueueSoon` for each.
 *
 * A daily cron (`integration-sync-scheduled`) walks all active connections and
 * calls `enqueue` for each — the full reconciliation baseline.
 */
@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly discord: DiscordAdapter,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROCESS_ROLE) private readonly processRole: ProcessRoleValue,
  ) {}

  async onModuleInit() {
    if (!isWorkerRole(this.processRole)) {
      this.logger.log(`PROCESS_ROLE=${this.processRole} — skipping sync consumers and cron`);
      return;
    }
    await this.queue.work(QUEUE_INTEGRATION_SYNC, async (data) => {
      const { connectionId } = data as SyncJobData;
      await this.runSync(connectionId);
    });

    await this.queue.work(QUEUE_INTEGRATION_SYNC_SCHEDULED, async () => {
      await this.sweepAllConnections();
    });

    // Daily full sync at 02:00 UTC — catches any drift the event-driven path missed.
    await this.queue.schedule(
      QUEUE_INTEGRATION_SYNC_SCHEDULED,
      '0 2 * * *',
      {},
      { singletonKey: QUEUE_INTEGRATION_SYNC_SCHEDULED },
    );
  }

  /** Enqueue an immediate sync for one connection. */
  async enqueue(connectionId: string): Promise<void> {
    await this.queue.publish(
      QUEUE_INTEGRATION_SYNC,
      { connectionId } satisfies SyncJobData,
      { singletonKey: `sync-${connectionId}` },
    );
  }

  /**
   * Enqueue a delayed sync. The singleton key means any additional `enqueueSoon`
   * calls within the window are no-ops — the already-queued job covers them.
   * Used after role grant/revoke to batch rapid membership edits.
   */
  async enqueueSoon(connectionId: string): Promise<void> {
    await this.queue.publish(
      QUEUE_INTEGRATION_SYNC,
      { connectionId } satisfies SyncJobData,
      {
        singletonKey: `sync-${connectionId}`,
        startAfterSeconds: this.env.INTEGRATION_SYNC_DELAY_SECONDS,
      },
    );
  }

  /**
   * Called by UsersService after any user_role grant or revoke. Finds every active
   * connection that has at least one mapping for `roleId` and schedules a debounced
   * sync for it. Fire-and-forget; sync failure never fails the role-change request.
   */
  async notifyRoleChange(roleId: string): Promise<void> {
    try {
      const mappings = await this.prisma.externalGroupMapping.findMany({
        where: { roleId },
        select: { connectionId: true },
        distinct: ['connectionId'],
      });
      await Promise.all(mappings.map((m) => this.enqueueSoon(m.connectionId)));
    } catch (err) {
      this.logger.warn(`notifyRoleChange for ${roleId} failed: ${(err as Error).message}`);
    }
  }

  private async runSync(connectionId: string): Promise<void> {
    try {
      await this.discord.sync(connectionId);
    } catch (err) {
      this.logger.error(`Sync failed for connection ${connectionId}: ${(err as Error).message}`);
    }
  }

  private async sweepAllConnections(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { lifecycleState: 'active', status: { not: 'disabled' } },
      select: { id: true },
    });
    this.logger.log(`Scheduled sweep: enqueueing sync for ${connections.length} connection(s)`);
    await Promise.all(connections.map((c) => this.enqueue(c.id)));
  }
}
