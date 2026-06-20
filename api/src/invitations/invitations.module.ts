import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService, BootstrapService],
  exports: [InvitationsService, BootstrapService],
})
export class InvitationsModule {}
