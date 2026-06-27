import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { DiscordAuthController } from './discord-auth.controller';
import { DiscordAuthService } from './discord-auth.service';

/**
 * Discord-as-an-auth-provider (login + invite register) plus the user-driven
 * account connect/disconnect. Imports AuthModule (DiscordOAuthService,
 * SessionService, AuthService), InvitationsModule (redemption), and
 * IntegrationsModule (DiscordLinkService). Kept separate from AuthModule so the
 * InvitationsModule → AuthModule dependency doesn't become a cycle.
 */
@Module({
  imports: [AuthModule, InvitationsModule, IntegrationsModule],
  controllers: [DiscordAuthController],
  providers: [DiscordAuthService],
})
export class DiscordAuthModule {}
