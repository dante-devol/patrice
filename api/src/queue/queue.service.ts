import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { ENV, Env } from '../config/env';
import { ServiceUnavailableError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { JOB_QUEUES, JobQueue, deadLetterQueue } from './job-queues';

/** Something that can run a queue's due jobs in this process (sync mode). */
export interface LocalJobRunner {
  drain(queue: JobQueue): Promise<void>;
}

/** A job that ran out of retries, as the admin sees it (no job data: it may hold PII). */
export interface DeadLetter {
  id: string;
  queue: string;
  failedAt: Date;
}

/**
 * Publishes background jobs (pg-boss). This side runs in every process, and never
 * works a queue or runs a schedule: that's the worker's {@link JobRunner}.
 *
 * Publishing fails loudly. When pg-boss isn't running, or a send fails, the caller
 * gets `503 QUEUE_UNAVAILABLE` instead of a silently dropped job, and `/health`
 * reports the queue down.
 *
 * In `sync` mode (tests) a publish also runs the queue's due jobs in-process before
 * returning, so a test sees a job's effects without polling.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;
  private localRunner: LocalJobRunner | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Start publishing. A failure leaves the queue down (and `/health` degraded). */
  async start(): Promise<void> {
    if (this.boss) return;
    if (this.env.QUEUE_MODE === 'off') {
      this.logger.warn('QUEUE_MODE=off: background jobs are disabled; publishing will fail.');
      return;
    }
    const boss = new PgBoss({ connectionString: this.env.DATABASE_URL, supervise: false, schedule: false });
    boss.on('error', (err) => this.logger.error('pg-boss error', err));
    try {
      await boss.start();
      this.boss = boss;
    } catch (err) {
      this.logger.error(`pg-boss failed to start: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    await boss?.stop({ graceful: true, wait: true }).catch(() => undefined);
  }

  /** Whether jobs can be published right now. */
  get healthy(): boolean {
    return this.boss !== null;
  }

  /** Throw `503 QUEUE_UNAVAILABLE` unless jobs can be published. */
  assertAvailable(): void {
    if (!this.boss) throw new ServiceUnavailableError('QUEUE_UNAVAILABLE', 'Background jobs are unavailable; try again later');
  }

  /** In sync mode, the worker's runner drains queues right after a publish. */
  attachLocalRunner(runner: LocalJobRunner): void {
    this.localRunner = runner;
  }

  /**
   * Publish a job. `singletonKey` drops a send whose key matches a job already queued
   * or running; `startAfterSeconds` delays it, so a singleton absorbs follow-on events
   * inside the window. Throws `503 QUEUE_UNAVAILABLE` if the job can't be queued.
   */
  async publish(
    queue: JobQueue,
    data: object,
    opts: { singletonKey?: string; startAfterSeconds?: number } = {},
  ): Promise<void> {
    this.assertAvailable();
    const boss = this.boss!;
    try {
      await ensureQueue(boss, queue);
      await boss.send(queue, data, {
        ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
        ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
      });
    } catch (err) {
      this.logger.error(`Publishing to "${queue}" failed: ${(err as Error).message}`);
      throw new ServiceUnavailableError('QUEUE_UNAVAILABLE', 'Background jobs are unavailable; try again later');
    }
    if (this.env.QUEUE_MODE === 'sync' && this.localRunner && !opts.startAfterSeconds) {
      await this.localRunner.drain(queue);
    }
  }

  /** Jobs that exhausted their retries, newest first. */
  async deadLetters(limit = 100): Promise<DeadLetter[]> {
    if (!this.boss) throw new ServiceUnavailableError('QUEUE_UNAVAILABLE', 'Background jobs are unavailable; try again later');
    const dead = (Object.keys(JOB_QUEUES) as JobQueue[]).map(deadLetterQueue);
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; name: string; created_on: Date }[]>(
      `SELECT id::text, name, created_on FROM pgboss.job
       WHERE name = ANY($1::text[]) AND state = 'created'
       ORDER BY created_on DESC LIMIT $2`,
      dead,
      limit,
    );
    return rows.map((r) => ({ id: r.id, queue: r.name.replace(/\.dead$/, ''), failedAt: r.created_on }));
  }
}

const ensured = new WeakMap<PgBoss, Set<string>>();

/** Create a queue (and its dead-letter queue) with its policy, once per pg-boss instance. */
export async function ensureQueue(boss: PgBoss, queue: JobQueue): Promise<void> {
  let done = ensured.get(boss);
  if (!done) ensured.set(boss, (done = new Set()));
  if (done.has(queue)) return;
  const dead = deadLetterQueue(queue);
  const options = { name: queue, ...JOB_QUEUES[queue], deadLetter: dead };
  if (!(await boss.getQueue(dead))) await boss.createQueue(dead, { name: dead }).catch(ignoreExists);
  if (await boss.getQueue(queue)) await boss.updateQueue(queue, options);
  else await boss.createQueue(queue, options).catch(ignoreExists);
  done.add(queue);
}

/** Two processes may race to create the same queue; the loser's error is harmless. */
function ignoreExists(err: Error): void {
  if (!/already exists|duplicate key/i.test(err.message)) throw err;
}
