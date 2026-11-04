import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GcService } from './gc.service';
import { GcController } from './gc.controller';

/**
 * Retirement GC. The admin endpoints ({@link GcController}) drive {@link GcService}
 * directly; the hourly sweep runs in the worker ({@link GcWorker}).
 */
@Module({
  imports: [IntegrationsModule],
  providers: [GcService],
  controllers: [GcController],
  exports: [GcService],
})
export class GcModule {}
