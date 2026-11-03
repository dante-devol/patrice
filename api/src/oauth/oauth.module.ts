import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LOGIN_PROVIDERS } from '../auth/providers/login-provider';
import { DiscordLoginProvider } from './discord.login-provider';
import { OAuthLoginService } from './oauth-login.service';
import { OAuthController } from './oauth.controller';

/**
 * OAuth sign-in for every provider in the login-provider slot. To add a provider,
 * write an adapter and add it to the LOGIN_PROVIDERS list below. Kept apart from
 * AuthModule so the InvitationsModule → AuthModule dependency doesn't become a cycle.
 */
@Module({
  imports: [AuthModule, InvitationsModule, IntegrationsModule],
  controllers: [OAuthController],
  providers: [
    DiscordLoginProvider,
    {
      provide: LOGIN_PROVIDERS,
      useFactory: (discord: DiscordLoginProvider) => [discord],
      inject: [DiscordLoginProvider],
    },
    OAuthLoginService,
  ],
})
export class OAuthModule {}
