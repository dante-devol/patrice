import { Injectable } from '@nestjs/common';
import { AuthMethod, AuthProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeniedError, UnauthenticatedError } from '../common/errors';
import { PasswordService } from './password';

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
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
    return {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.identities[0]?.verifiedAt != null,
    };
  }

  static passwordAuthMethod(): AuthMethod {
    return AuthMethod.password;
  }
}
