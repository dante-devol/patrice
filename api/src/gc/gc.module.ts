import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { GcService } from './gc.service';
import { GcController } from './gc.controller';

/** The pg-boss queue + singleton key for the GC sweep (multi-instance safe). */
export const GC_QUEUE = 'gc-sweep';

/**
 * Retirement GC (Slice 7.3). Registers the sweep as a pg-boss worker and schedules it
 * hourly with `singletonKey: 'gc-sweep'` so a multi-instance deployment never double-
 * sweeps. The admin endpoints ({@link GcController}) drive {@link GcService} directly,
 * so the sweep is fully exercisable even when the queue is disabled (tests).
 */
@Module({
  providers: [GcService],
  controllers: [GcController],
  exports: [GcService],
})
export class GcModule implements OnModuleInit {
  private readonly logger = new Logger(GcModule.name);

  constructor(
    private readonly queue: QueueService,
    private readonly gc: GcService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.work(GC_QUEUE, async () => {
      const report = await this.gc.sweep();
      this.logger.log(
        `GC sweep: ${report.tasks.length} tasks, ${report.divisions.length} divisions, ` +
          `${report.teams.length} teams, ${report.roles.length} roles collected; ` +
          `${report.blocked.length} blocked; ${report.orphanedBlobs} orphan blobs.`,
      );
    });
    // Hourly cadence (long, per the slice) — grace guarantees the revive window
    // independent of sweep timing, so immediacy isn't needed.
    await this.queue.schedule(GC_QUEUE, '0 * * * *', {}, { singletonKey: GC_QUEUE });
  }
}
