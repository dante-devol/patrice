import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';
import { PROCESS_ROLE, type ProcessRoleValue } from '../common/process-role';

/**
 * Global config module. Validates the environment once at module construction so a
 * misconfigured deployment never reaches request handling.
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => loadEnv(),
    },
    {
      provide: PROCESS_ROLE,
      useFactory: (): ProcessRoleValue => {
        const raw = process.env.PROCESS_ROLE;
        if (raw === 'api' || raw === 'worker') return raw;
        return 'combined';
      },
    },
  ],
  exports: [ENV, PROCESS_ROLE],
})
export class ConfigModule {}
