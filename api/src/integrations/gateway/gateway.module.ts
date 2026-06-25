import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IntegrationsModule } from '../integrations.module';
import { IntegrationGatewayService } from './integration-gateway.service';

@Module({
  imports: [PrismaModule, forwardRef(() => IntegrationsModule)],
  providers: [IntegrationGatewayService],
  exports: [IntegrationGatewayService],
})
export class GatewayModule {}
