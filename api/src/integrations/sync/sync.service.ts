import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { ENV, Env } from '../../config/env';
import { DiscordAdapter } from './discord.adapter';
import { PROCESS_ROLE, isWorkerRole, type ProcessRoleValue } from '../../common/process-role';

const QUEUE_INTEGRATION_SYNC = 'integration-sync';
const QUEUE_INTEGRATION_SYNC_SCHEDULED = 'integration-sync-scheduled';
const QUEUE_RECONCILE_FLOOR = 'integration-reconcile-floor';

// Adaptive reconcile floor: 6h when Gateway is healthy, 30min when degraded.
const FLOOR_HEALTHY_HOURS = 6;
const FLOOR_DEGRADED_HOURS = 0.5;


export interface SyncJobData {
  connectionId: string;
  /** When set, reconcile only this Discord user's edges (Doorbell fast path). */
  externalUserId?: string;
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

  /** Gateway health state per connectionId — updated by IntegrationGatewayService. */
  private readonly gatewayHealth = new Map<string, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly discord: DiscordAdapter,
    @Inject(ENV) private readonly env: Env,
    @Inject(PROCESS_ROLE) private readonly processRole: ProcessRoleValue,
  ) {}

  /** Called by IntegrationGatewayService when health changes. */
  setGatewayHealth(connectionId: string, healthy: boolean): void {
    this.gatewayHealth.set(connectionId, healthy);
  }

  async onModuleInit() {
    if (!isWorkerRole(this.processRole)) {
      this.logger.log(`PROCESS_ROLE=${this.processRole} — skipping sync consumers and cron`);
      return;
    }
    await this.queue.work(QUEUE_INTEGRATION_SYNC, async (data) => {
      const { connectionId, externalUserId } = data as SyncJobData;
      if (externalUserId) await this.runSyncUser(connectionId, externalUserId);
      else await this.runSync(connectionId);
    });

    await this.queue.work(QUEUE_INTEGRATION_SYNC_SCHEDULED, async () => {
      await this.sweepAllConnections();
    });

    // Adaptive Reconcile Floor (#61): 30-min tick; effective floor is 6h when
    // Gateway is healthy, 30min when degraded. Replaces the former daily 02:00 sweep.
    await this.queue.work(QUEUE_RECONCILE_FLOOR, async () => {
      await this.reconcileFloorTick();
    });
    await this.queue.schedule(
      QUEUE_RECONCILE_FLOOR,
      '*/30 * * * *', // every 30 minutes
      {},
      { singletonKey: QUEUE_RECONCILE_FLOOR },
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
   * Enqueue a delayed **single-user** reconcile (Doorbell fast path). Keyed per
   * (connection, user) so bursts for one member collapse but different members
   * don't block each other. The connection-wide sweep remains the correctness
   * backstop; this just narrows the common case to the user who actually changed.
   */
  async enqueueUserSoon(connectionId: string, externalUserId: string): Promise<void> {
    await this.queue.publish(
      QUEUE_INTEGRATION_SYNC,
      { connectionId, externalUserId } satisfies SyncJobData,
      {
        singletonKey: `sync-${connectionId}-${externalUserId}`,
        startAfterSeconds: this.env.INTEGRATION_SYNC_DELAY_SECONDS,
      },
    );
  }

  /**
   * Called by UsersService after a Patrice-side grant/revoke for **one** user. Mirrors
   * the Gateway Doorbell: for each mapped connection the user is linked to, enqueue a
   * **targeted, debounced reconcile of just that user** — so a Patrice change pulses to
   * Discord at the same ~5s pace as a Discord-side change, instead of waiting for the
   * Reconcile Floor. The per-(connection,user) singleton key also avoids contending
   * with the full-connection sweeps (which share `sync-{connection}`). An unlinked user
   * has no Discord account to push to, so they simply produce no job. Fire-and-forget.
   */
  async notifyUserRoleChange(userId: string, roleId: string): Promise<void> {
    try {
      const mappings = await this.prisma.externalGroupMapping.findMany({
        where: { roleId },
        select: { connectionId: true },
        distinct: ['connectionId'],
      });
      if (mappings.length === 0) return;
      const links = await this.prisma.externalIdentity.findMany({
        where: { userId, connectionId: { in: mappings.map((m) => m.connectionId) } },
        select: { connectionId: true, externalUserId: true },
      });
      await Promise.all(
        links.map((l) => this.enqueueUserSoon(l.connectionId, l.externalUserId)),
      );
    } catch (err) {
      this.logger.warn(`notifyUserRoleChange for ${userId}/${roleId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Role-wide reconcile: schedule a full sweep of every connection mapping `roleId`.
   * For changes that affect many holders at once (e.g. a role retirement), not a
   * single grant/revoke — those use {@link notifyUserRoleChange}.
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

  private async runSyncUser(connectionId: string, externalUserId: string): Promise<void> {
    try {
      await this.discord.syncUser(connectionId, externalUserId);
    } catch (err) {
      this.logger.error(
        `User sync failed for ${connectionId}/${externalUserId}: ${(err as Error).message}`,
      );
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

  /**
   * Adaptive Reconcile Floor tick (#61).
   *
   * Runs every 30 min. For each active connection:
   *  - If the Gateway is healthy: only sync if last run > 6h ago.
   *  - If the Gateway is degraded: always sync (30-min effective floor).
   * When degraded, also logs a warning so operators know the fast-path is down.
   */
  private async reconcileFloorTick(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { lifecycleState: 'active', status: { not: 'disabled' } },
      select: { id: true, updatedAt: true },
    });

    const now = Date.now();
    for (const conn of connections) {
      const gatewayHealthy = this.gatewayHealth.get(conn.id) ?? false;
      const floorHours = gatewayHealthy ? FLOOR_HEALTHY_HOURS : FLOOR_DEGRADED_HOURS;
      const staleSinceMs = floorHours * 60 * 60 * 1000;
      const age = now - conn.updatedAt.getTime();

      if (!gatewayHealthy) {
        this.logger.warn(`Gateway degraded for ${conn.id} — floor tightened to ${FLOOR_DEGRADED_HOURS * 60}min`);
      }

      if (age >= staleSinceMs) {
        await this.enqueue(conn.id);
      }
    }
  }
}
