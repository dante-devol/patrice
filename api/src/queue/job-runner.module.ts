import { Global, Module } from '@nestjs/common';
import { JobRunner } from './job-runner.service';

/** The worker's job runner. Global, so worker-only modules can register consumers. */
@Global()
@Module({ providers: [JobRunner], exports: [JobRunner] })
export class JobRunnerModule {}
