import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider, AuthTokenKind, Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { SessionService } from './session.service';
import { PasswordService } from './password';
import { AuthMailService } from './auth-mail.service';
import { hashToken } from '../common/tokens';
import { ConflictError, ValidationError } from '../common/errors';

/**
 * Email-ownership verification, password reset and email change (auth_token flows).
 *
 * Both "request" endpoints return success unconditionally for a non-existent email
 * (no enumeration oracle). Password-reset confirmation ALWAYS requires a verified
 * identity (closes the unverified-email account-hijack-via-reset path) and revokes
 * all of the user's sessions (the "doubt" path).
 *
 * Every confirm consumes its token with a guarded update inside the transaction that
 * applies the change, so two concurrent confirms can't both succeed.
 */
@Injectable()
export class VerificationService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly mail: AuthMailService,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Consume a live token of `kind` inside `tx`, or return null. The `consumedAt: null`
   * guard on the update makes consumption atomic.
   */
  private async consume(tx: Prisma.TransactionClient, token: string, kind: AuthTokenKind) {
    const row = await tx.authToken.findUnique({
      where: { tokenHash: hashToken(this.env.TOKEN_PEPPER, token) },
      select: { id: true, userId: true, kind: true, expiresAt: true, newEmail: true },
    });
    if (!row || row.kind !== kind || new Date() >= row.expiresAt) return null;
    const { count } = await tx.authToken.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1 ? row : null;
  }

  /** Mail a verification link to an active user (at registration and on resend). */
  async issueVerification(userId: string): Promise<void> {
    await this.mail.request({ kind: 'email_verification', userId });
  }

  /** Resend verification. Always reports success — no enumeration oracle. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.appUser.findFirst({
      where: { email, lifecycleState: 'active' },
      select: {
        id: true,
        identities: {
          where: { provider: AuthProvider.password, verifiedAt: null },
          select: { id: true },
        },
      },
    });
    if (user && user.identities.length > 0) await this.issueVerification(user.id);
  }

  /** Confirm an email-verification token; stamps verified_at on the identity. */
  async confirmVerification(token: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.consume(tx, token, AuthTokenKind.email_verification);
      if (!row) throw new ValidationError('Invalid or expired verification token');
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
      select: { id: true },
    });
    if (user) await this.mail.request({ kind: 'password_reset', userId: user.id });
  }

  /**
   * Confirm a password reset. Requires a verified identity (always-on invariant),
   * sets the new password, consumes the token, and revokes all sessions.
   */
  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const row = await this.consume(tx, token, AuthTokenKind.password_reset);
      if (!row) throw new ValidationError('Invalid or expired reset token');
      const identity = await tx.userIdentity.findFirst({
        where: { userId: row.userId, provider: AuthProvider.password },
        select: { id: true, verifiedAt: true },
      });
      if (!identity || identity.verifiedAt == null) {
        // Closes the unverified-email account-hijack-via-reset path.
        throw new ValidationError('Email must be verified before resetting the password');
      }
      await tx.userIdentity.update({ where: { id: identity.id }, data: { passwordHash } });
      await this.sessions.revokeAllForUser(row.userId, tx);
    });
  }

  /** Mail a confirmation link to the new address; the email changes once it's confirmed. */
  async requestEmailChange(userId: string, newEmail: string): Promise<void> {
    await this.assertEmailFree(userId, newEmail);
    await this.mail.request({ kind: 'email_change', userId, newEmail });
  }

  /**
   * Confirm an email change: the new address becomes the user's email, and the
   * password identity (if any) counts as verified, since the link proves control.
   */
  async confirmEmailChange(token: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.consume(tx, token, AuthTokenKind.email_change);
      if (!row?.newEmail) throw new ValidationError('Invalid or expired email-change token');
      await this.assertEmailFree(row.userId, row.newEmail, tx);
      await tx.appUser.update({
        where: { id: row.userId },
        data: { email: row.newEmail, version: { increment: 1 } },
      });
      await tx.userIdentity.updateMany({
        where: { userId: row.userId, provider: AuthProvider.password },
        data: { verifiedAt: new Date() },
      });
      await this.activity.logActivity({
        tx,
        actorUserId: row.userId,
        subjectType: 'user',
        subjectId: row.userId,
        verb: 'auth.email_changed',
        payload: { userId: row.userId },
      });
    });
  }

  private async assertEmailFree(
    userId: string,
    email: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const taken = await db.appUser.findFirst({
      where: { email, id: { not: userId } },
      select: { id: true },
    });
    if (taken) throw new ConflictError('EMAIL_TAKEN', 'That email address is already in use');
  }
}
