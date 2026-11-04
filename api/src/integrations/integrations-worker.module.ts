import { Module } from '@nestjs/common';
import { IntegrationsModule } from './integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TokenVault } from './token-vault';
import { TokenWorker } from './token.worker';
import { DiscordRestClient } from './sync/discord-rest.client';
import { DiscordAdapter } from './sync/discord.adapter';
import { INTEGRATION_SYNC_PORT } from './sync/integration-sync.port';
import { SyncEngine } from './sync/sync-engine';
import { SyncWorker } from './sync/sync.worker';
import { IntegrationGatewayService } from './gateway/integration-gateway.service';

/**
 * Integrations, the worker's part: the only holder of the bot-token key, the sync
 * engine behind the provider port, and the Discord Gateway. Imported by
 * WorkerModule only.
 */
@Module({
  imports: [IntegrationsModule, NotificationsModule],
  providers: [
    TokenVault,
    TokenWorker,
    DiscordRestClient,
    DiscordAdapter,
    { provide: INTEGRATION_SYNC_PORT, useExisting: DiscordAdapter },
    SyncEngine,
    SyncWorker,
    IntegrationGatewayService,
  ],
  exports: [IntegrationGatewayService, SyncEngine, TokenVault],
})
export class IntegrationsWorkerModule {}
