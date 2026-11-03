import { UserAccount } from './user-account';

/** Persistence port for {@link UserAccount}. */
export interface UserAccountRepository {
  findById(userId: string): Promise<UserAccount | null>;
  /** The user who holds this provider account, if any. */
  ownerOf(provider: 'google' | 'discord', subject: string): Promise<string | null>;
  /** Version-guarded on the user row: throws `STALE_VERSION` on a concurrent change. */
  save(account: UserAccount): Promise<void>;
}
