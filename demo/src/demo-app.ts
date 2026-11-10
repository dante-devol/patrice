import 'reflect-metadata';
import { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
// The Rust-free client the demo build generates from the API's schema (scripts/make.mjs).
import { PrismaClient } from 'demo-prisma-client';
import { ApiModule } from '../../api/src/api.module';
import { PrismaService } from '../../api/src/prisma/prisma.service';
import { QueueService } from '../../api/src/queue/queue.service';
import { PasswordService } from '../../api/src/auth/password';
import { STORAGE_PORT } from '../../api/src/storage/storage.port';
import { DemoQueueService } from './demo-queue';
import { DemoPasswordService } from './demo-password';
import { MemoryStorageAdapter } from './memory-storage';
export { setDemoEnv } from './demo-env';

/** Nest's default logger writes to process.stdout, which a browser doesn't have. */
const consoleLogger: LoggerService = {
  log: (m, ctx) => console.log(`[${ctx ?? 'Nest'}]`, m),
  error: (m, ...rest) => console.error(m, ...rest),
  warn: (m, ctx) => console.warn(`[${ctx ?? 'Nest'}]`, m),
  debug: () => undefined,
  verbose: () => undefined,
};

/**
 * The real HTTP module (every controller, guard, Cedar policy and service), with the
 * server-only pieces swapped: Postgres → PGlite, pg-boss → a no-op queue, native
 * argon2 → WebAssembly argon2, object storage → memory.
 */
export async function createDemoApp(db: PGlite): Promise<INestApplication> {
  // The adapter is built against an older driver-adapter-utils; same runtime shape.
  const prisma = new PrismaClient({
    adapter: new PrismaPGlite(db) as never,
    // PGlite is one connection, so transactions queue behind each other instead of
    // running side by side; give a queued one longer than Prisma's 2 s to start.
    transactionOptions: { maxWait: 15_000, timeout: 15_000 },
  });
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .setLogger(consoleLogger)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(QueueService)
    .useClass(DemoQueueService)
    .overrideProvider(PasswordService)
    .useClass(DemoPasswordService)
    .overrideProvider(STORAGE_PORT)
    .useValue(new MemoryStorageAdapter())
    .compile();
  const app = moduleRef.createNestApplication({ logger: consoleLogger });
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.setGlobalPrefix('api');
  return app;
}
