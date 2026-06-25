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
import { SECRET_CIPHER_PORT } from './secret-cipher.port';

@Module({
  imports: [PrismaModule, ActivityModule, CommonModule, QueueModule, ConfigModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    SyncService,
    DiscordAdapter,
    AeadEnvAdapter,
    { provide: SECRET_CIPHER_PORT, useExisting: AeadEnvAdapter },
  ],
  exports: [SyncService],
})
export class IntegrationsModule {}
