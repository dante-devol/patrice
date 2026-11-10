import { Injectable, Logger } from '@nestjs/common';
import type { DeadLetter, LocalJobRunner } from '../../api/src/queue/queue.service';
import type { JobQueue } from '../../api/src/queue/job-queues';

type Handler = (data: unknown) => Promise<void>;

/**
 * Demo stand-in for both sides of the job queue (QueueService, which publishes, and
 * JobRunner, which workers register with). There is no worker process in the browser,
 * so a published job runs right away, in the request that published it, through
 * whichever real worker registered for its queue (`auth.mail`: AuthMailWorker). Jobs
 * nobody handles in the demo (integration sync, GC) are logged and dropped. A failed
 * job is logged, never failing the request, as with a real queue.
 */
@Injectable()
export class DemoQueueService {
  private readonly logger = new Logger('DemoQueue');
  private readonly handlers = new Map<string, Handler>();
  readonly healthy = true;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  assertAvailable(): void {}
  attachLocalRunner(_runner: LocalJobRunner): void {}

  /** JobRunner's side: a worker registers for a queue. */
  register(queue: JobQueue, handler: Handler): void {
    this.handlers.set(queue, handler);
  }

  async publish(queue: string, data?: unknown): Promise<string | null> {
    const handler = this.handlers.get(queue);
    if (!handler) {
      this.logger.log(`job dropped in demo: ${queue}`);
      return null;
    }
    try {
      await handler(data);
    } catch (e) {
      this.logger.warn(`job ${queue} failed: ${(e as Error).message}`);
    }
    return null;
  }

  async deadLetters(): Promise<DeadLetter[]> {
    return [];
  }
}
