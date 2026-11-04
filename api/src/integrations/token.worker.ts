import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { IntegrationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobRunner } from '../queue/job-runner.service';
import { TokenVault } from './token-vault';
import { IntegrationGatewayService } from './gateway/integration-gateway.service';
import { SyncService } from './sync/sync.service';

/** The API hands a new bot token over in this job; nothing else carries plaintext. */
export interface StoreTokenJob {
  connectionId: string;
  botToken: string;
}

/**
 * Worker: bot-token custody.
 *
 * - `integration.store-token` encrypts a token the API received (connect, rotate),
 *   stores it, wipes the job's data, then restarts the connection's Gateway session
 *   and syncs it.
 * - At boot, tokens left in plaintext by older versions are encrypted, and handles
 *   from the dropped Vault/KMS adapters are flagged for rotation.
 */
@Injectable()
export class TokenWorker implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(TokenWorker.name);

  constructor(
    private readonly runner: JobRunner,
    private readonly prisma: PrismaService,
    private readonly vault: TokenVault,
    private readonly gateway: IntegrationGatewayService,
    private readonly sync: SyncService,
  ) {}

  onModuleInit(): void {
    this.runner.register('integration.store-token', async (data, jobId) => {
      try {
        await this.store(data as StoreTokenJob);
      } finally {
        await this.prisma
          .$executeRawUnsafe(`UPDATE pgboss.job SET data = '{}'::jsonb WHERE id = $1::uuid`, jobId)
          .catch((err) => this.logger.error(`Could not wipe token job ${jobId}: ${(err as Error).message}`));
      }
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.upgradeLegacyTokens();
  }

  private async store({ connectionId, botToken }: StoreTokenJob): Promise<void> {
    const conn = await this.prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    if (!conn) return;
    await this.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { credentialsRef: this.vault.encrypt(botToken), status: IntegrationStatus.active, lastError: null },
    });
    await this.gateway.reconcileSession(connectionId);
    await this.sync.enqueue(connectionId);
  }

  private async upgradeLegacyTokens(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      select: { id: true, config: true, credentialsRef: true },
    });
    for (const c of connections) {
      const config = (c.config ?? {}) as Record<string, unknown>;
      const plaintext = typeof config.botToken === 'string' ? config.botToken : null;
      if (plaintext) {
        const { botToken: _drop, ...rest } = config;
        await this.prisma.integrationConnection.update({
          where: { id: c.id },
          data: { credentialsRef: this.vault.encrypt(plaintext), config: rest as Prisma.InputJsonValue },
        });
        this.logger.log(`Encrypted a plaintext bot token for connection ${c.id}`);
      } else if (c.credentialsRef && !TokenVault.isHandle(c.credentialsRef)) {
        await this.prisma.integrationConnection.update({
          where: { id: c.id },
          data: {
            credentialsRef: null,
            status: IntegrationStatus.broken,
            lastError: 'This bot token was stored in a way Patrice no longer supports. Rotate the token.',
          },
        });
      }
    }
  }
}
