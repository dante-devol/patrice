import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SecretStore } from './secret-store.service';

@Global()
@Module({
  providers: [SettingsService, SecretStore],
  exports: [SettingsService, SecretStore],
})
export class SettingsModule {}
