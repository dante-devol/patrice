import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { ENV, Env } from '../../config/env';




export interface SyncJobData {
  connectionId: string;
  /** When set, reconcile only this Discord user's edges (Doorbell fast path). */
  externalUserId?: string;
}

/**
 * Integration sync orchestration. The API side enqueues: `enqueue` (now),
 * `enqueueSoon` (debounced per connection) and `enqueueUserSoon` (debounced per user).
 * The worker's SyncWorker runs the jobs (through the provider-neutral SyncEngine) and
 * the reconcile floor.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Enqueue an immediate sync for one connection. */
  async enqueue(connectionId: string): Promise<void> {
    await this.queue.publish(
      'integration.sync',
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
      'integration.sync',
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
      'integration.sync',
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
}
