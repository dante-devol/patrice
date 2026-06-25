import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { IntegrationGatewayService } from './integration-gateway.service';

@Module({
  imports: [PrismaModule],
  providers: [IntegrationGatewayService],
  exports: [IntegrationGatewayService],
})
export class GatewayModule {}
