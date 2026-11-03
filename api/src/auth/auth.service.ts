import { Injectable } from '@nestjs/common';
import { AuthMethod, AuthProvider } from '@prisma/client';
import { discordAvatarUrl } from '../common/discord-avatar';
import { PrismaService } from '../prisma/prisma.service';
import { DeniedError, UnauthenticatedError } from '../common/errors';
import { AccessService, ORGANIZATION_RESOURCE } from '../access/access.service';
import { SettingsService } from '../settings/settings.service';
import { ACTIONS } from '../access/actions';
import { PasswordService } from './password';

/**
 * The org-wide actions reported in `/me`'s `allowedActions`. These are hints the
 * client uses to show or hide controls; the API re-authorizes every action, so a
 * stale or spoofed list changes nothing server-side.
 */
export const ORG_VIEW_ACTIONS: readonly string[] = [
  ACTIONS.inviteCreate.action,
  ACTIONS.configUpdate.action,
  ACTIONS.grantCreate.action,
  ACTIONS.roleCreate.action,
  ACTIONS.divisionCreate.action,
  ACTIONS.integrationCreate.action,
];

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  /** Sign-in methods the user holds (password / google / discord). */
  authMethods: AuthMethod[];
  /** True if the user has at least one active Discord account link (integration). */
  hasDiscordLink: boolean;
  /** The linked Discord handle (for "Connected as …"); null when unlinked. */
  discordHandle: string | null;
  /** Discord avatar CDN URL when linked + an avatar hash is known (#52). */
  avatarUrl: string | null;
  /** Org-wide actions the user may perform (see ORG_VIEW_ACTIONS). */
  allowedActions: string[];
  /** True when `requireDiscordLink` currently blocks this user's task access. */
  taskAccessBlockedByDiscord: boolean;
}

/**
 * Email+password authentication. Login verifies the password identity and, when
 * `system_settings.require_verified_email_to_log_in` is on, rejects unverified
 * identities with a *distinct* error so the client can route to "resend verification".
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
  ) {}

  /** Verify credentials; throws 401 on failure, 403 EMAIL_NOT_VERIFIED when gated. */
  async verifyPassword(email: string, password: string): Promise<{ userId: string }> {
    const user = await this.prisma.appUser.findFirst({
      where: { email, lifecycleState: 'active' },
      select: {
        id: true,
        identities: {
          where: { provider: AuthProvider.password },
          select: { passwordHash: true, verifiedAt: true },
        },
      },
    });
    const identity = user?.identities[0];

    // Run a verify against a dummy hash on the miss path to blunt timing oracles.
    if (!user || !identity?.passwordHash) {
      await this.passwords.verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
        password,
      );
      throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const ok = await this.passwords.verify(identity.passwordHash, password);
    if (!ok) {
      throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if ((await this.settings.get()).requireVerifiedEmailToLogIn) {
      if (!identity.verifiedAt) {
        throw new DeniedError('EMAIL_NOT_VERIFIED', 'Email address is not verified');
      }
    }
    return { userId: user.id };
  }

  /** Load the current-user projection for `GET /me`. */
  async getMe(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        identities: {
          select: { provider: true, verifiedAt: true },
        },
      },
    });
    if (!user) throw new UnauthenticatedError();

    // The org-wide actions the client shows controls for, asked the same way the
    // guards will ask. Per-entity rights come with each entity (`allowedActions`).
    const [allowedActions, gate, avatarLink] = await Promise.all([
      this.access.allowedActions(user.id, ORGANIZATION_RESOURCE, ORG_VIEW_ACTIONS),
      // The principal carries the requireDiscordLink gate as a computed flag.
      this.access.buildPrincipal(user.id),
      // Most recently synced active link (carries handle + avatar hash, #52).
      this.prisma.externalIdentity.findFirst({
        where: {
          userId: user.id,
          connection: { lifecycleState: 'active' },
        },
        orderBy: { lastSyncedAt: { sort: 'desc', nulls: 'last' } },
        select: { externalUserId: true, externalAvatarHash: true, externalHandle: true },
      }),
    ]);

    const passwordIdentity = user.identities.find(
      (i) => i.provider === AuthProvider.password,
    );

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      // An OAuth-only user (no password identity) has nothing to verify — don't nag.
      emailVerified: passwordIdentity ? passwordIdentity.verifiedAt != null : true,
      authMethods: user.identities.map((i) => i.provider),
      hasDiscordLink: avatarLink != null,
      discordHandle: avatarLink?.externalHandle ?? null,
      avatarUrl: discordAvatarUrl(avatarLink?.externalUserId, avatarLink?.externalAvatarHash),
      allowedActions,
      taskAccessBlockedByDiscord: gate.entities[0].attrs.discordGated === true,
    };
  }

  static passwordAuthMethod(): AuthMethod {
    return AuthMethod.password;
  }
}
