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

@Module({
  imports: [PrismaModule, ActivityModule, CommonModule, QueueModule, ConfigModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, SyncService, DiscordAdapter],
})
export class IntegrationsModule {}
