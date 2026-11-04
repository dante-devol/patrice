/**
 * Every background job queue, with its retry policy. Publishers and the worker both
 * create queues from this table, so a queue's policy is defined once. A job that
 * exhausts its retries moves to `<queue>.dead`, which the admin can inspect.
 */
export interface QueuePolicy {
  /** Retries after the first failure. */
  retryLimit: number;
  /** Seconds before the first retry; doubles each time when `retryBackoff` is set. */
  retryDelay: number;
  retryBackoff: boolean;
  /** False for jobs whose data must not be copied anywhere (no dead-letter queue). */
  deadLetter?: false;
}

export const JOB_QUEUES = {
  /** Mint and mail a single-use auth link (verify, reset, email change). */
  'auth.mail': { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  /** Project undelivered domain events into notifications (also run every minute). */
  'events.deliver': { retryLimit: 3, retryDelay: 10, retryBackoff: true },
  /** The retirement GC sweep (hourly). */
  'gc.sweep': { retryLimit: 2, retryDelay: 300, retryBackoff: false },
  /** Reconcile one connection, or one user on it, with the provider. */
  'integration.sync': { retryLimit: 5, retryDelay: 30, retryBackoff: true },
  /** The reconcile floor tick (every 30 minutes). */
  'integration.reconcile-floor': { retryLimit: 1, retryDelay: 60, retryBackoff: false },
  /**
   * Hand a bot token from the API to the worker, which encrypts and stores it: the
   * API never holds the key. Not retried and never dead-lettered, and the worker
   * wipes the job's data once it has run, so the plaintext doesn't linger.
   */
  'integration.store-token': { retryLimit: 0, retryDelay: 0, retryBackoff: false, deadLetter: false },
  /** Open, restart or close a connection's Gateway session after an admin change. */
  'gateway.reconcile-sessions': { retryLimit: 5, retryDelay: 15, retryBackoff: true },
} as const satisfies Record<string, QueuePolicy>;

/** Queues whose failed jobs move to a dead-letter queue. */
export const DEAD_LETTERED_QUEUES = (Object.keys(JOB_QUEUES) as (keyof typeof JOB_QUEUES)[]).filter(
  (q) => (JOB_QUEUES[q] as QueuePolicy).deadLetter !== false,
);

export type JobQueue = keyof typeof JOB_QUEUES;

export const deadLetterQueue = (queue: JobQueue): string => `${queue}.dead`;

/** How the queue runs: `normal` in production, `sync` in tests, `off` to disable it. */
export type QueueMode = 'normal' | 'sync' | 'off';
