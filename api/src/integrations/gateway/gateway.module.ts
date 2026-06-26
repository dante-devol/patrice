import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ActivityModule } from '../../activity/activity.module';
import { IntegrationsModule } from '../integrations.module';
import { IntegrationGatewayService } from './integration-gateway.service';

@Module({
  imports: [PrismaModule, ActivityModule, forwardRef(() => IntegrationsModule)],
  providers: [IntegrationGatewayService],
  exports: [IntegrationGatewayService],
})
export class GatewayModule {}
