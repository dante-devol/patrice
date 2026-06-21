import { Global, Module } from '@nestjs/common';
import { GraceService } from './grace.service';

/**
 * Cross-cutting domain helpers shared across feature modules. Global so any service
 * can inject {@link GraceService} (the per-org Grace Period resolver) without each
 * feature module re-providing it.
 */
@Global()
@Module({
  providers: [GraceService],
  exports: [GraceService],
})
export class CommonModule {}
