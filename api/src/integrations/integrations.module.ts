import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ActivityModule } from '../activity/activity.module';
import { CommonModule } from '../common/common.module';
import { QueueModule } from '../queue/queue.module';
import { ConfigModule } from '../config/config.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { SyncService } from './sync/sync.service';
import { DiscordAdapter } from './sync/discord.adapter';
import { AeadEnvAdapter } from './aead-env.adapter';
import { VaultTransitAdapter } from './vault-transit.adapter';
import { KmsEnvelopeAdapter } from './kms-envelope.adapter';
import { CompositeCipherAdapter } from './composite-cipher.adapter';
import { SECRET_CIPHER_PORT } from './secret-cipher.port';
import { DiscordRestClient } from './sync/discord-rest.client';
import { GatewayModule } from './gateway/gateway.module';

@Module({
  imports: [PrismaModule, ActivityModule, CommonModule, QueueModule, ConfigModule, GatewayModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    SyncService,
    DiscordAdapter,
    DiscordRestClient,
    AeadEnvAdapter,
    VaultTransitAdapter,
    KmsEnvelopeAdapter,
    CompositeCipherAdapter,
    { provide: SECRET_CIPHER_PORT, useExisting: CompositeCipherAdapter },
  ],
  exports: [SyncService],
})
export class IntegrationsModule {}
