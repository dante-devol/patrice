/* eslint-disable */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

/** Truncate all Slice 1 tables for a clean run (before bootstrap seeds). */
export async function resetDatabase(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE organization, app_user, user_identity, session, invitation,
       invitation_use, auth_token, role, user_role, "grant", activity
       RESTART IDENTITY CASCADE;`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

export interface BootedApp {
  app: INestApplication;
  logs: string[];
  bootstrapKey: string | null;
}

/** Boot a Nest app, capturing stdout so the bootstrap key can be recovered. */
export async function bootApp(): Promise<BootedApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());

  const logs: string[] = [];
  const original = console.log.bind(console);
  const spy = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    // Keep quiet during tests but retain capture.
  };
  // eslint-disable-next-line no-console
  console.log = spy as typeof console.log;
  try {
    await app.init();
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }

  const keyLine = logs.find((l) => l.includes('PATRICE BOOTSTRAP KEY:'));
  const bootstrapKey = keyLine
    ? (keyLine.match(/PATRICE BOOTSTRAP KEY:\s*(\S+)/)?.[1] ?? null)
    : null;

  return { app, logs, bootstrapKey };
}

/** Extract a cookie value from a set-cookie header array. */
export function cookieValue(setCookie: string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  for (const c of setCookie) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Build a Cookie header string from a set-cookie array (name=value pairs). */
export function cookieHeader(setCookie: string[] | undefined): string {
  if (!setCookie) return '';
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}
