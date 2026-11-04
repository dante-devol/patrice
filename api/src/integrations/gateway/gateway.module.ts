import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations.module';
import { IntegrationGatewayService } from './integration-gateway.service';

/** The Discord Gateway listener. Worker only (imported by WorkerModule). */
@Module({
  imports: [IntegrationsModule],
  providers: [IntegrationGatewayService],
  exports: [IntegrationGatewayService],
})
export class GatewayModule {}
