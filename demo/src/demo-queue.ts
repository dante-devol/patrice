import { Injectable, Logger } from '@nestjs/common';
import type { DeadLetter, LocalJobRunner } from '../../api/src/queue/queue.service';

/**
 * Demo stand-in for QueueService: there is no worker in the browser, so published
 * jobs (emails, integration syncs, GC) are logged and dropped.
 */
@Injectable()
export class DemoQueueService {
  private readonly logger = new Logger('DemoQueue');
  readonly healthy = true;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  assertAvailable(): void {}
  attachLocalRunner(_runner: LocalJobRunner): void {}
  async publish(queue: string, ..._rest: unknown[]): Promise<string | null> {
    this.logger.log(`job dropped in demo: ${queue}`);
    return null;
  }
  async deadLetters(): Promise<DeadLetter[]> {
    return [];
  }
}
