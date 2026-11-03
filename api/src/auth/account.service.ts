import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors';
import { DomainError } from '../domain/shared/domain-error';
import { UserAccount } from '../domain/account/user-account';
import { UnitOfWork, UnitOfWorkContext } from '../infrastructure/unit-of-work';
import { PasswordService } from './password';
import { SessionService } from './session.service';
import { VerificationService } from './verification.service';
import { ExternalProfile } from './providers/login-provider';

/**
 * Self-service account commands: sign-in methods, password and email. The rule that
 * an account always keeps a way in lives in the {@link UserAccount} aggregate.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
  ) {}

  /** Attach an external sign-in account (the OAuth `link` flow). Idempotent. */
  async attachIdentity(
    userId: string,
    provider: 'google' | 'discord',
    profile: ExternalProfile,
  ): Promise<void> {
    await this.uow.run(userId, async (ctx) => {
      const owner = await ctx.accounts.ownerOf(provider, profile.subject);
      if (owner && owner !== userId) {
        throw new DomainError('IDENTITY_TAKEN', 'That account is already linked to another Patrice user');
      }
      const account = await this.load(ctx, userId);
      account.attach(provider, profile.subject, new Date());
      await ctx.accounts.save(account);
    });
  }

  /** Remove a sign-in method, refusing to remove the last one. */
  async detachIdentity(userId: string, provider: 'password' | 'google' | 'discord'): Promise<void> {
    await this.uow.run(userId, async (ctx) => {
      const account = await this.load(ctx, userId);
      account.detach(provider);
      await ctx.accounts.save(account);
    });
  }

  /**
   * Change the password (needs the current one), or add a first password to a
   * provider-only account. Every other session is signed out on a change.
   */
  async setPassword(
    userId: string,
    sessionId: string | undefined,
    args: { currentPassword?: string; newPassword: string },
  ): Promise<void> {
    const newHash = await this.passwords.hash(args.newPassword);
    const added = await this.uow.run(userId, async (ctx) => {
      const account = await this.load(ctx, userId);
      const existing = account.method('password');
      if (existing) {
        const ok =
          !!args.currentPassword &&
          !!existing.passwordHash &&
          (await this.passwords.verify(existing.passwordHash, args.currentPassword));
        if (!ok) throw new DomainError('WRONG_PASSWORD', 'The current password is wrong');
      }
      account.setPassword(newHash);
      await ctx.accounts.save(account);
      if (existing) await this.sessions.revokeAllForUser(userId, ctx.tx, sessionId);
      return !existing;
    });
    if (added) await this.verification.issueVerification(userId);
  }

  /**
   * Start an email change. Accounts with a password must confirm it; the address
   * changes only when the link mailed to the new address is followed.
   */
  async requestEmailChange(
    userId: string,
    args: { newEmail: string; currentPassword?: string },
  ): Promise<void> {
    await this.uow.run(userId, async (ctx) => {
      const account = await this.load(ctx, userId);
      const password = account.method('password');
      if (password) {
        const ok =
          !!args.currentPassword &&
          !!password.passwordHash &&
          (await this.passwords.verify(password.passwordHash, args.currentPassword));
        if (!ok) throw new DomainError('WRONG_PASSWORD', 'The current password is wrong');
      }
    });
    await this.verification.requestEmailChange(userId, args.newEmail);
  }

  private async load(ctx: UnitOfWorkContext, userId: string): Promise<UserAccount> {
    const account = await ctx.accounts.findById(userId);
    if (!account) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    return account;
  }
}
