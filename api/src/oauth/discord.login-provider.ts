import { Injectable } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import { DiscordOAuthService } from '../auth/discord-oauth.service';
import { ExternalProfile, LoginProvider, OAuthIntent } from '../auth/providers/login-provider';
import { DiscordLinkService } from '../integrations/discord-link.service';

/**
 * Discord in the login-provider slot. Beyond sign-in, linking Discord also creates
 * the user's integration links (role sync), and unlinking removes them.
 */
@Injectable()
export class DiscordLoginProvider implements LoginProvider {
  readonly id = AuthProvider.discord;

  constructor(
    private readonly oauth: DiscordOAuthService,
    private readonly links: DiscordLinkService,
  ) {}

  isConfigured(): Promise<boolean> {
    return this.oauth.isConfigured();
  }

  authorizeUrl(state: string, intent: OAuthIntent): Promise<string> {
    // `email` only seeds a contact address at registration; login and link need just
    // the stable id, so ask for the minimal scope per intent.
    return this.oauth.authorizeUrl(state, intent === 'register' ? 'identify email' : 'identify');
  }

  async exchange(code: string): Promise<ExternalProfile> {
    const u = await this.oauth.fetchUser(await this.oauth.exchangeCode(code));
    return {
      subject: u.id,
      username: u.username,
      displayName: u.globalName,
      email: u.email,
      avatar: u.avatar,
    };
  }

  afterLink(userId: string, profile: ExternalProfile): Promise<void> {
    return this.links.linkConnections(userId, profile);
  }

  afterUnlink(userId: string): Promise<boolean> {
    return this.links.removeLinks(userId);
  }
}
