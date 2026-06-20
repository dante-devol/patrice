import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service';
import { AdministrabilityService } from './administrability.service';
import { AuthorizeGuard } from './authorize.guard';
import { CedarEngine } from './cedar/engine';

/**
 * The access engine module — the cross-cutting authorization spine. Exported
 * globally so any feature module can declare `@Authorize(...)` routes and so
 * bootstrap can read the effective-admin predicate.
 */
@Global()
@Module({
  providers: [CedarEngine, AccessService, AdministrabilityService, AuthorizeGuard],
  exports: [CedarEngine, AccessService, AdministrabilityService, AuthorizeGuard],
})
export class AccessModule {}
