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
  /** Open, restart or close a connection's Gateway session after an admin change. */
  'gateway.reconcile-sessions': { retryLimit: 5, retryDelay: 15, retryBackoff: true },
} as const satisfies Record<string, QueuePolicy>;

export type JobQueue = keyof typeof JOB_QUEUES;

export const deadLetterQueue = (queue: JobQueue): string => `${queue}.dead`;

/** How the queue runs: `normal` in production, `sync` in tests, `off` to disable it. */
export type QueueMode = 'normal' | 'sync' | 'off';
