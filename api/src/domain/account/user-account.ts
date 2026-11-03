import { AggregateRoot } from '../shared/aggregate';
import { DomainError } from '../shared/domain-error';

export type SignInProvider = 'password' | 'google' | 'discord';

export interface SignInMethod {
  /** Null until saved. */
  id: string | null;
  provider: SignInProvider;
  /** The provider's account id; null for password. */
  subject: string | null;
  /** Password methods only. */
  passwordHash: string | null;
  verifiedAt: Date | null;
}

export interface UserAccountState {
  id: string;
  version: number;
  email: string | null;
  methods: SignInMethod[];
}

/**
 * A user's sign-in methods. Owns the rule that an account always keeps at least one
 * way in, and that it holds at most one method per provider.
 */
export class UserAccount extends AggregateRoot {
  private _methods: SignInMethod[];
  /** Methods removed since load; the repository deletes them on save. */
  readonly removed: SignInMethod[] = [];
  readonly email: string | null;

  private constructor(s: UserAccountState) {
    super(s.id, s.version);
    this.email = s.email;
    this._methods = s.methods.map((m) => ({ ...m }));
  }

  static restore(s: UserAccountState): UserAccount {
    return new UserAccount(s);
  }

  get methods(): readonly SignInMethod[] {
    return this._methods;
  }

  method(provider: SignInProvider): SignInMethod | undefined {
    return this._methods.find((m) => m.provider === provider);
  }

  /**
   * Attach an external sign-in method. Re-attaching the same account is a no-op; a
   * different account at the same provider is refused (one per provider). The caller
   * checks that no *other* user holds this account.
   */
  attach(provider: Exclude<SignInProvider, 'password'>, subject: string, now: Date): void {
    const existing = this.method(provider);
    if (existing?.subject === subject) return;
    if (existing) {
      throw new DomainError(
        'PROVIDER_ALREADY_CONNECTED',
        'A different account from this provider is already connected; disconnect it first',
      );
    }
    this._methods.push({ id: null, provider, subject, passwordHash: null, verifiedAt: now });
    this.raise({
      type: 'auth.identity_linked',
      subjectType: 'user',
      subjectId: this.id,
      payload: { userId: this.id, provider },
    });
  }

  /** Remove a sign-in method, never the last one. */
  detach(provider: SignInProvider): void {
    const m = this.method(provider);
    if (!m) throw new DomainError('NOT_LINKED', 'That sign-in method is not connected');
    if (this._methods.length === 1) {
      throw new DomainError(
        'LAST_AUTH_METHOD',
        'Add another sign-in method before removing this one; it is your only way to log in',
      );
    }
    this._methods = this._methods.filter((x) => x !== m);
    this.removed.push(m);
    this.raise({
      type: 'auth.identity_unlinked',
      subjectType: 'user',
      subjectId: this.id,
      payload: { userId: this.id, provider },
    });
  }

  /**
   * Set a password. Adding one to a provider-only account needs an email address to
   * sign in with, and the new password method starts unverified (the caller mails a
   * verification link).
   */
  setPassword(passwordHash: string): void {
    const existing = this.method('password');
    if (existing) {
      existing.passwordHash = passwordHash;
      this.raise({
        type: 'auth.password_changed',
        subjectType: 'user',
        subjectId: this.id,
        payload: { userId: this.id },
      });
      return;
    }
    if (!this.email) {
      throw new DomainError('VALIDATION_FAILED', 'Add an email address before setting a password');
    }
    this._methods.push({ id: null, provider: 'password', subject: null, passwordHash, verifiedAt: null });
    this.raise({
      type: 'auth.identity_linked',
      subjectType: 'user',
      subjectId: this.id,
      payload: { userId: this.id, provider: 'password' },
    });
  }
}
