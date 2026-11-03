import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, Env } from '../config/env';
import { decryptOAuthSecret, isOAuthSecretHandle } from '../auth/oauth-secret.cipher';
import { decryptSecret, encryptSecret } from './secret-cipher';

/** Every secret purpose the system stores. Adding one is a deliberate code change. */
export const SECRET_PURPOSES = ['discord_oauth_client_secret'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Encrypted secrets, one row per purpose, encrypted under a per-purpose key derived
 * from SECRETS_KEY. Plaintext never leaves this service except to the caller that
 * asked for it; no read endpoint returns a secret.
 */
@Injectable()
export class SecretStore {
  private readonly logger = new Logger(SecretStore.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async has(purpose: SecretPurpose, db: Db = this.prisma): Promise<boolean> {
    return (await db.secret.count({ where: { purpose } })) > 0;
  }

  /**
   * The plaintext, or null when unset or undecryptable (e.g. after a key change; the
   * admin re-enters it). Secrets written before SECRETS_KEY existed were encrypted
   * under a SESSION_SECRET-derived key; they are re-encrypted on first read.
   */
  async get(purpose: SecretPurpose): Promise<string | null> {
    const row = await this.prisma.secret.findUnique({ where: { purpose } });
    if (!row) return null;
    try {
      if (isOAuthSecretHandle(row.ciphertext)) {
        const plaintext = decryptOAuthSecret(this.env.SESSION_SECRET, row.ciphertext);
        await this.put(purpose, plaintext);
        return plaintext;
      }
      return decryptSecret(this.env.SECRETS_KEY, purpose, row.ciphertext);
    } catch (err) {
      this.logger.error(`Secret "${purpose}" failed to decrypt; re-enter it: ${(err as Error).message}`);
      return null;
    }
  }

  async put(purpose: SecretPurpose, plaintext: string, db: Db = this.prisma): Promise<void> {
    const ciphertext = encryptSecret(this.env.SECRETS_KEY, purpose, plaintext);
    await db.secret.upsert({
      where: { purpose },
      create: { purpose, ciphertext },
      update: { ciphertext },
    });
  }

  async clear(purpose: SecretPurpose, db: Db = this.prisma): Promise<void> {
    await db.secret.deleteMany({ where: { purpose } });
  }
}
