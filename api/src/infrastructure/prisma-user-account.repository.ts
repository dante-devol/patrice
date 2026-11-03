import { Prisma } from '@prisma/client';
import { UserAccount } from '../domain/account/user-account';
import { UserAccountRepository } from '../domain/account/user-account.repository';
import { DomainError } from '../domain/shared/domain-error';
import { EventSink } from './unit-of-work';

/** Prisma adapter for {@link UserAccountRepository}, bound to one transaction. */
export class PrismaUserAccountRepository implements UserAccountRepository {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly sink: EventSink,
  ) {}

  async findById(userId: string): Promise<UserAccount | null> {
    const user = await this.tx.appUser.findUnique({
      where: { id: userId },
      select: { id: true, version: true, email: true, identities: true },
    });
    if (!user) return null;
    return UserAccount.restore({
      id: user.id,
      version: user.version,
      email: user.email,
      methods: user.identities.map((i) => ({
        id: i.id,
        provider: i.provider,
        subject: i.providerSubject,
        passwordHash: i.passwordHash,
        verifiedAt: i.verifiedAt,
      })),
    });
  }

  async ownerOf(provider: 'google' | 'discord', subject: string): Promise<string | null> {
    const row = await this.tx.userIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: subject } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  async save(a: UserAccount): Promise<void> {
    const next = a.version + 1;
    const { count } = await this.tx.appUser.updateMany({
      where: { id: a.id, version: a.version },
      data: { version: next },
    });
    if (count === 0) {
      throw new DomainError('STALE_VERSION', 'The account changed since it was read; reload and retry');
    }
    for (const m of a.removed) {
      if (m.id) await this.tx.userIdentity.delete({ where: { id: m.id } });
    }
    for (const m of a.methods) {
      if (m.id) {
        await this.tx.userIdentity.update({
          where: { id: m.id },
          data: { passwordHash: m.passwordHash, verifiedAt: m.verifiedAt },
        });
      } else {
        const created = await this.tx.userIdentity.create({
          data: {
            userId: a.id,
            provider: m.provider,
            providerSubject: m.subject,
            passwordHash: m.passwordHash,
            verifiedAt: m.verifiedAt,
          },
          select: { id: true },
        });
        m.id = created.id;
      }
    }
    a.markSaved(next);
    this.sink(a.pullEvents());
  }
}
