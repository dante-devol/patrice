import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core.module';
import { AuthorizeGuard } from './access/authorize.guard';
import { SessionGuard } from './auth/session.guard';
import { AuthenticatedGuard } from './auth/authenticated.guard';
import { HealthController } from './health/health.controller';
import { JobsController } from './queue/jobs.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ContractCheckInterceptor } from './contract/contract-check.interceptor';

/**
 * The HTTP process: the shared core plus the request pipeline. It publishes jobs but
 * never consumes a queue, runs a schedule, sends email or opens a Gateway socket
 * (ADR 0003; asserted by test/process-topology.e2e-spec.ts).
 */
@Module({
  imports: [
    // App-wide request ceiling (in-memory store — fits the single-instance v1 topology;
    // a multi-instance deployment would swap in a shared store). Credential/token routes
    // tighten this further with @Throttle (see auth/invitations controllers). Skipped
    // under NODE_ENV=test so the e2e suite's repeated logins/redemptions don't 429.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    CoreModule,
  ],
  controllers: [HealthController, JobsController],
  providers: [
    // Order matters: throttle before any work, then SessionGuard resolves identity
    // (+ CSRF), then AuthenticatedGuard 401s non-public routes without a session, then
    // the AuthorizeGuard enforces the declared Cedar action.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
    { provide: APP_GUARD, useClass: AuthorizeGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Tests validate every response against the contract (contract/routes.ts).
    ...(process.env.NODE_ENV === 'test'
      ? [{ provide: APP_INTERCEPTOR, useClass: ContractCheckInterceptor }]
      : []),
  ],
})
export class ApiModule {}
