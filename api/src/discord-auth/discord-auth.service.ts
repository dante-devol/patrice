import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UnauthenticatedError, UnprocessableError } from '../common/errors';
import { DiscordOAuthService, type DiscordOAuthUser } from '../auth/discord-oauth.service';
import { InvitationsService } from '../invitations/invitations.service';
import { signOAuthState, type OAuthStatePayload } from '../auth/oauth-state';

/**
 * Discord-as-an-auth-provider orchestration: the unauthenticated **login** and
 * invite **register** intents. The `user_identity[discord]` row is the auth record;
 * it is connection-independent (uses the app-level OAuth client) and never depends
 * on an integration connection existing. Account creation stays invite-only — a
 * login that matches no existing identity is rejected, never auto-provisioned
 * (ARCHITECTURE.md §2.2). The authenticated **link** intent lives in Phase 2.
 */
@Injectable()
export class DiscordAuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly oauth: DiscordOAuthService,
    private readonly invitations: InvitationsService,
  ) {}

  /** Build the Discord authorize URL for a given intent, encoding signed state. */
  startUrl(intent: OAuthStatePayload['intent'], ctx: { inviteToken?: string; userId?: string }): string {
    if (!this.oauth.isConfigured()) {
      throw new UnprocessableError('DISCORD_NOT_CONFIGURED', 'Discord sign-in is not configured');
    }
    // `email` is only useful to seed a contact address at registration; login/link
    // need just the stable id, so request the minimal scope per intent.
    const scope = intent === 'register' ? 'identify email' : 'identify';
    const state = signOAuthState(this.env.SESSION_SECRET, { intent, ...ctx });
    return this.oauth.authorizeUrl(state, scope);
  }

  /** Resolve an existing Discord identity to its (active) user, or reject. */
  async completeLogin(discordUser: DiscordOAuthUser): Promise<string> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: AuthProvider.discord,
          providerSubject: discordUser.id,
        },
      },
      select: { userId: true, user: { select: { lifecycleState: true } } },
    });
    if (!identity || identity.user.lifecycleState !== 'active') {
      throw new UnauthenticatedError(
        'DISCORD_NO_ACCOUNT',
        'No active Patrice account is linked to this Discord login',
      );
    }
    return identity.userId;
  }

  /** Redeem an invite, minting a Discord sign-in identity for the new user. */
  async completeRegister(inviteToken: string, discordUser: DiscordOAuthUser): Promise<string> {
    const displayName = discordUser.globalName ?? discordUser.username;
    const { userId } = await this.invitations.acceptWithDiscord({
      token: inviteToken,
      email: discordUser.email,
      displayName,
      discordUserId: discordUser.id,
    });
    return userId;
  }
}
