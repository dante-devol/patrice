import { Module } from '@nestjs/common';
import { CoreModule } from './core.module';
import { EmailModule } from './email/email.module';
import { IntegrationsWorkerModule } from './integrations/integrations-worker.module';
import { JobRunnerModule } from './queue/job-runner.module';
import { AuthMailWorker } from './auth/auth-mail.worker';
import { DeliveryWorker } from './events/delivery.worker';
import { GcWorker } from './gc/gc.worker';
import { BootstrapWorker } from './invitations/bootstrap.worker';

/**
 * The background process: the shared core plus everything that runs on its own —
 * queue consumers and schedules, email, the Discord Gateway and bootstrap mode.
 * Run one worker; it holds the Gateway sessions.
 */
@Module({
  imports: [CoreModule, JobRunnerModule, EmailModule, IntegrationsWorkerModule],
  providers: [AuthMailWorker, DeliveryWorker, GcWorker, BootstrapWorker],
})
export class WorkerModule {}
