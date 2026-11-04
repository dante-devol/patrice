import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { DiscordLinkService } from './discord-link.service';
import { SyncService } from './sync/sync.service';

/**
 * Integrations, the part both processes share: connection and mapping admin, sync
 * links, and enqueueing syncs. No bot token is ever opened here; that, the sync
 * engine and the Gateway are in {@link IntegrationsWorkerModule}.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, DiscordLinkService, SyncService],
  exports: [IntegrationsService, SyncService, DiscordLinkService],
})
export class IntegrationsModule {}
