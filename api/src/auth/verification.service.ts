import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider, AuthTokenKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { SessionService } from './session.service';
import { PasswordService } from './password';
import { generateOpaqueToken, hashToken } from '../common/tokens';
import { ValidationError } from '../common/errors';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Email-ownership verification + password reset (auth_token flows).
 *
 * Both "request" endpoints return success unconditionally for a non-existent email
 * (no enumeration oracle). Password-reset confirmation ALWAYS requires a verified
 * identity (closes the unverified-email account-hijack-via-reset path) and revokes
 * all of the user's sessions (the "doubt" path).
 */
@Injectable()
export class VerificationService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
  ) {}

  private async issueToken(
    userId: string,
    kind: AuthTokenKind,
    ttlMs: number,
  ): Promise<string> {
    const token = generateOpaqueToken();
    await this.prisma.authToken.create({
      data: {
        userId,
        kind,
        tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  private async consumableToken(token: string, kind: AuthTokenKind) {
    const tokenHash = hashToken(this.env.TOKEN_PEPPER, token);
    const row = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, kind: true, expiresAt: true, consumedAt: true },
    });
    if (!row || row.kind !== kind) return null;
    if (row.consumedAt) return null;
    if (new Date() >= row.expiresAt) return null;
    return row;
  }

  /** Issue a verification email for an active user (used at registration + resend). */
  async issueVerification(userId: string, email: string): Promise<void> {
    const token = await this.issueToken(userId, AuthTokenKind.email_verification, VERIFICATION_TTL_MS);
    await this.email.sendVerificationEmail(email, token);
  }

  /** Resend verification. Always reports success — no enumeration oracle. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.appUser.findFirst({
      where: { email, lifecycleState: 'active' },
      select: {
        id: true,
        email: true,
        identities: {
          where: { provider: AuthProvider.password, verifiedAt: null },
          select: { id: true },
        },
      },
    });
    if (user?.email && user.identities.length > 0) {
      await this.issueVerification(user.id, user.email);
    }
  }

  /** Confirm an email-verification token; stamps verified_at on the identity. */
  async confirmVerification(token: string): Promise<void> {
    const row = await this.consumableToken(token, AuthTokenKind.email_verification);
    if (!row) throw new ValidationError('Invalid or expired verification token');
    await this.prisma.$transaction(async (tx) => {
      await tx.authToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      await tx.userIdentity.updateMany({
        where: { userId: row.userId, provider: AuthProvider.password },
        data: { verifiedAt: new Date() },
      });
    });
  }

  /** Request a password reset. Always reports success — no enumeration oracle. */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.appUser.findFirst({
      where: { email, lifecycleState: 'active' },
      select: { id: true, email: true },
    });
    if (user?.email) {
      const token = await this.issueToken(user.id, AuthTokenKind.password_reset, RESET_TTL_MS);
      await this.email.sendPasswordResetEmail(user.email, token);
    }
  }

  /**
   * Confirm a password reset. Requires a verified identity (always-on invariant),
   * sets the new password, consumes the token, and revokes all sessions.
   */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const row = await this.consumableToken(token, AuthTokenKind.password_reset);
    if (!row) throw new ValidationError('Invalid or expired reset token');

    const identity = await this.prisma.userIdentity.findFirst({
      where: { userId: row.userId, provider: AuthProvider.password },
      select: { id: true, verifiedAt: true },
    });
    if (!identity || identity.verifiedAt == null) {
      // Closes the unverified-email account-hijack-via-reset path.
      throw new ValidationError('Email must be verified before resetting the password');
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.authToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      });
      await tx.userIdentity.update({
        where: { id: identity.id },
        data: { passwordHash },
      });
      await this.sessions.revokeAllForUser(row.userId, tx);
    });
  }
}
