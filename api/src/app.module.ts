import { Module } from '@nestjs/common';
import { ApiModule } from './api.module';
import { WorkerModule } from './worker.module';

/**
 * API and worker in one process, for development and tests. Production runs them
 * separately (PROCESS_ROLE=api / worker; see main.ts).
 */
@Module({ imports: [ApiModule, WorkerModule] })
export class AppModule {}
