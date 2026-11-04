import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

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
  ],
  exports: [ENV],
})
export class ConfigModule {}
