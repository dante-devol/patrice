import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import PgBoss from 'pg-boss';
import { ENV, Env } from '../config/env';

/**
 * pg-boss wrapper (Postgres-backed jobs). Slice 1 uses it for email send; GC sweeps
 * (Slice 7) and integration sync (Slice 8) land here later. Resilient by design: if
 * the queue can't start, publishing degrades to a logged no-op so the core request
 * path (bootstrap/auth/authz) is never blocked by queue health.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;
  private readonly pendingWorkers: Array<{
    queue: string;
    handler: (data: unknown) => Promise<void>;
  }> = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    if (process.env.DISABLE_QUEUE === 'true') {
      this.logger.warn('DISABLE_QUEUE=true — pg-boss disabled (jobs are no-ops).');
      return;
    }
    try {
      this.boss = new PgBoss({ connectionString: this.env.DATABASE_URL });
      this.boss.on('error', (err) => this.logger.error('pg-boss error', err));
      await this.boss.start();
      for (const w of this.pendingWorkers) {
        await this.registerWorker(w.queue, w.handler);
      }
    } catch (err) {
      this.boss = null;
      this.logger.error(
        `pg-boss failed to start; jobs disabled. ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true }).catch(() => undefined);
  }

  private async registerWorker(
    queue: string,
    handler: (data: unknown) => Promise<void>,
  ): Promise<void> {
    if (!this.boss) return;
    await this.boss.createQueue(queue).catch(() => undefined);
    await this.boss.work(queue, async (jobs: PgBoss.Job[]) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }

  /** Register a worker for a queue. Deferred until pg-boss has started. */
  async work(queue: string, handler: (data: unknown) => Promise<void>): Promise<void> {
    if (this.boss) {
      await this.registerWorker(queue, handler);
    } else {
      this.pendingWorkers.push({ queue, handler });
    }
  }

  /**
   * Publish a job. No-op (logged) when the queue is unavailable. `singletonKey`
   * de-duplicates in-flight jobs (pg-boss drops a send whose key matches one already
   * active) — the GC sweep passes `'gc-sweep'` so concurrent triggers can't overlap.
   */
  async publish(
    queue: string,
    data: unknown,
    opts: { singletonKey?: string } = {},
  ): Promise<void> {
    if (!this.boss) {
      this.logger.warn(`Queue unavailable; dropping job for "${queue}".`);
      return;
    }
    await this.boss.createQueue(queue).catch(() => undefined);
    await this.boss.send(
      queue,
      data as object,
      opts.singletonKey ? { singletonKey: opts.singletonKey } : {},
    );
  }

  /**
   * Schedule a recurring job on a cron expression. The `singletonKey` keeps a
   * multi-instance deployment from double-running the same sweep. No-op when the
   * queue is unavailable (jobs disabled).
   */
  async schedule(
    queue: string,
    cron: string,
    data: unknown = {},
    opts: { singletonKey?: string } = {},
  ): Promise<void> {
    if (!this.boss) {
      this.logger.warn(`Queue unavailable; not scheduling "${queue}".`);
      return;
    }
    await this.boss.createQueue(queue).catch(() => undefined);
    await this.boss.schedule(
      queue,
      cron,
      data as object,
      opts.singletonKey ? { singletonKey: opts.singletonKey } : {},
    );
  }
}
