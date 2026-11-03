import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Every secret purpose the system stores. Adding one is a deliberate code change. */
export const SECRET_PURPOSES = ['discord_oauth_client_secret'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Storage for encrypted secrets, one row per purpose. This store holds ciphertext
 * only; encrypting and decrypting is the caller's job, with the key for that purpose.
 */
@Injectable()
export class SecretStore {
  constructor(private readonly prisma: PrismaService) {}

  async get(purpose: SecretPurpose, db: Db = this.prisma): Promise<string | null> {
    const row = await db.secret.findUnique({ where: { purpose } });
    return row?.ciphertext ?? null;
  }

  async has(purpose: SecretPurpose, db: Db = this.prisma): Promise<boolean> {
    return (await db.secret.count({ where: { purpose } })) > 0;
  }

  async put(purpose: SecretPurpose, ciphertext: string, db: Db = this.prisma): Promise<void> {
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
