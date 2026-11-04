import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRunner } from '../queue/job-runner.service';
import { GcService } from './gc.service';

/**
 * Worker: the hourly GC sweep. Grace guarantees the revive window independently of
 * sweep timing, so the cadence can be relaxed. pg-boss runs one sweep at a time.
 */
@Injectable()
export class GcWorker implements OnModuleInit {
  private readonly logger = new Logger(GcWorker.name);

  constructor(
    private readonly runner: JobRunner,
    private readonly gc: GcService,
  ) {}

  onModuleInit(): void {
    this.runner.register('gc.sweep', async () => {
      const r = await this.gc.sweep();
      this.logger.log(
        `GC sweep: ${r.tasks.length} tasks, ${r.divisions.length} divisions, ${r.teams.length} teams, ` +
          `${r.roles.length} roles; ${r.blocked.length} blocked; ${r.orphanedBlobs} orphan blobs; ` +
          `${r.pendingUploads} pending uploads.`,
      );
    });
    this.runner.schedule('gc.sweep', '0 * * * *');
  }
}
