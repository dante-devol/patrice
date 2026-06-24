import { Injectable } from '@nestjs/common';
import { AuthMethod, AuthProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeniedError, UnauthenticatedError } from '../common/errors';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { PasswordService } from './password';

/**
 * Reflected capabilities for UX (web "Permission Reflection"). These are hints the
 * client uses to show/hide controls — the API still re-authorizes every action, so
 * a stale or spoofed capability changes nothing server-side.
 */
export interface UserCapabilities {
  /** May create invitations (also gates the invitations management page). */
  inviteCreate: boolean;
  /** May author org config — gates the admin area (roles/divisions/teams/matrix). */
  manageOrg: boolean;
}

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  /** True if the user has at least one active Discord account link. */
  hasDiscordLink: boolean;
  capabilities: UserCapabilities;
}

/**
 * Email+password authentication. Login verifies the password identity and, when
 * `organization.settings.requireVerifiedEmailToLogIn` is on, rejects unverified
 * identities with a *distinct* error so the client can route to "resend verification".
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly access: AccessService,
  ) {}

  /** Verify credentials; throws 401 on failure, 403 EMAIL_NOT_VERIFIED when gated. */
  async verifyPassword(email: string, password: string): Promise<{ userId: string }> {
    const user = await this.prisma.appUser.findFirst({
      where: { email, lifecycleState: 'active' },
      select: {
        id: true,
        organizationId: true,
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

    if (await this.requireVerifiedLogin(user.organizationId)) {
      if (!identity.verifiedAt) {
        throw new DeniedError('EMAIL_NOT_VERIFIED', 'Email address is not verified');
      }
    }
    return { userId: user.id };
  }

  private async requireVerifiedLogin(organizationId: string): Promise<boolean> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    return settings.requireVerifiedEmailToLogIn === true;
  }

  /** Load the current-user projection for `GET /me`. */
  async getMe(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        displayName: true,
        identities: {
          where: { provider: AuthProvider.password },
          select: { verifiedAt: true },
        },
      },
    });
    if (!user) throw new UnauthenticatedError();

    // Reflect the user's UI-relevant capabilities by asking the access engine the
    // same questions the guards will ask. invite:create is a global action, so the
    // organization is the resource.
    const orgResource = {
      type: 'Organization' as const,
      id: user.organizationId,
    };
    const [inviteCreate, manageOrg, discordLinkCount] = await Promise.all([
      this.access.decide({
        userId: user.id,
        action: ACTIONS.inviteCreate.action,
        resource: orgResource,
      }),
      this.access.decide({
        userId: user.id,
        action: ACTIONS.grantCreate.action,
        resource: orgResource,
      }),
      this.prisma.externalIdentity.count({
        where: { userId: user.id, connection: { lifecycleState: 'active' } },
      }),
    ]);

    return {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.identities[0]?.verifiedAt != null,
      hasDiscordLink: discordLinkCount > 0,
      capabilities: { inviteCreate, manageOrg },
    };
  }

  static passwordAuthMethod(): AuthMethod {
    return AuthMethod.password;
  }
}
