import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import PgBoss from 'pg-boss';
import { ENV, Env } from '../config/env';
import { JobQueue } from './job-queues';
import { LocalJobRunner, QueueService, ensureQueue } from './queue.service';

/** A job handler; `jobId` lets a handler scrub its own job's data. */
type Handler = (data: unknown, jobId: string) => Promise<void>;

/**
 * The worker side of the queue: consumes queues and runs schedules. It exists only in
 * the worker process. Workers register their handlers and schedules while modules
 * initialise; the runner starts once the application has bootstrapped.
 *
 * A handler that throws fails its job, and pg-boss retries it under the queue's policy
 * (job-queues.ts) until it moves to the dead-letter queue.
 *
 * In `sync` mode (tests) nothing polls and no cron fires: schedules are recorded, and
 * a queue's due jobs run when something publishes to it (see QueueService).
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnModuleDestroy, LocalJobRunner {
  private readonly logger = new Logger(JobRunner.name);
  private readonly handlers = new Map<JobQueue, Handler>();
  private readonly schedules = new Map<JobQueue, string>();
  private boss: PgBoss | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly queue: QueueService,
  ) {}

  /** Consume a queue in this process. Call during module initialisation. */
  register(queue: JobQueue, handler: Handler): void {
    if (this.handlers.has(queue)) throw new Error(`Queue "${queue}" already has a handler`);
    this.handlers.set(queue, handler);
  }

  /** Run a queue on a cron schedule. The queue must also have a handler. */
  schedule(queue: JobQueue, cron: string): void {
    this.schedules.set(queue, cron);
  }

  /** The queues this worker consumes, and the schedules it registered. */
  get registration(): { queues: JobQueue[]; schedules: Record<string, string> } {
    return { queues: [...this.handlers.keys()], schedules: Object.fromEntries(this.schedules) };
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.env.QUEUE_MODE === 'off') {
      this.logger.warn('QUEUE_MODE=off: the worker consumes no jobs.');
      return;
    }
    for (const queue of this.schedules.keys()) {
      if (!this.handlers.has(queue)) throw new Error(`Schedule for "${queue}" has no handler`);
    }
    const sync = this.env.QUEUE_MODE === 'sync';
    const boss = new PgBoss({ connectionString: this.env.DATABASE_URL, supervise: !sync, schedule: !sync });
    boss.on('error', (err) => this.logger.error('pg-boss error', err));
    await boss.start();
    this.boss = boss;
    for (const [queue, handler] of this.handlers) {
      await ensureQueue(boss, queue);
      if (!sync) {
        await boss.work(queue, { batchSize: 1 }, async ([job]) => handler(job.data, job.id));
      }
    }
    for (const [queue, cron] of this.schedules) {
      await boss.schedule(queue, cron, {}, { singletonKey: queue });
    }
    if (sync) this.queue.attachLocalRunner(this);
    this.logger.log(`Worker consuming ${this.handlers.size} queue(s), ${this.schedules.size} schedule(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    await boss?.stop({ graceful: true, wait: true }).catch(() => undefined);
  }

  /** Run a queue's due jobs now, in this process (sync mode). */
  async drain(queue: JobQueue): Promise<void> {
    const handler = this.handlers.get(queue);
    const boss = this.boss;
    if (!handler || !boss) return;
    for (let round = 0; round < 10; round++) {
      const jobs = await boss.fetch<unknown>(queue, { batchSize: 10 });
      if (jobs.length === 0) return;
      for (const job of jobs) {
        try {
          await handler(job.data, job.id);
          await boss.complete(queue, job.id);
        } catch (err) {
          this.logger.error(`Job ${job.id} on "${queue}" failed: ${(err as Error).message}`);
          await boss.fail(queue, job.id, { message: (err as Error).message });
        }
      }
    }
  }
}
