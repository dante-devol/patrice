import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { EmailService } from '../src/email/email.service';

/** Truncate all Slice 1 tables for a clean run (before bootstrap seeds). */
export async function resetDatabase(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE organization, app_user, user_identity, session, invitation,
       invitation_use, auth_token, role, user_role, "grant", activity,
       division, team, questionnaire, question, task, task_claimant,
       message, attachment, notification
       RESTART IDENTITY CASCADE;`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A stand-in EmailService that records the plaintext token handed to each send
 * call. Tokens are only ever stored hashed (`auth_token.token_hash`), so the
 * confirm endpoints can only be exercised by capturing the plaintext here — at
 * the one point it exists outside the request that generated it.
 */
export interface EmailCapture {
  verifications: Array<{ to: string; token: string }>;
  resets: Array<{ to: string; token: string }>;
  /** Most-recent verification token issued to `to`, or null. */
  lastVerificationToken(to: string): string | null;
  /** Most-recent reset token issued to `to`, or null. */
  lastResetToken(to: string): string | null;
}

function lastFor(
  records: Array<{ to: string; token: string }>,
  to: string,
): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].to === to) return records[i].token;
  }
  return null;
}

/** Build a capturing EmailService stub + the capture it writes to. */
export function createEmailCapture(): { stub: object; capture: EmailCapture } {
  const verifications: Array<{ to: string; token: string }> = [];
  const resets: Array<{ to: string; token: string }> = [];
  const stub = {
    async onModuleInit(): Promise<void> {},
    async sendVerificationEmail(to: string, token: string): Promise<void> {
      verifications.push({ to, token });
    },
    async sendPasswordResetEmail(to: string, token: string): Promise<void> {
      resets.push({ to, token });
    },
  };
  const capture: EmailCapture = {
    verifications,
    resets,
    lastVerificationToken: (to) => lastFor(verifications, to),
    lastResetToken: (to) => lastFor(resets, to),
  };
  return { stub, capture };
}

export interface BootedApp {
  app: INestApplication;
  logs: string[];
  bootstrapKey: string | null;
}

export interface BootOptions {
  /** Override the EmailService with a capturing stub (see createEmailCapture). */
  emailStub?: object;
}

/** Boot a Nest app, capturing stdout so the bootstrap key can be recovered. */
export async function bootApp(options: BootOptions = {}): Promise<BootedApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.emailStub) {
    builder = builder.overrideProvider(EmailService).useValue(options.emailStub);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  // Mirror main.ts: every route is served under the /api/* prefix.
  app.setGlobalPrefix('api');

  const logs: string[] = [];
  const original = console.log.bind(console);
  const spy = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
    // Keep quiet during tests but retain capture.
  };
   
  console.log = spy as typeof console.log;
  try {
    await app.init();
  } finally {
     
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

export interface AdminSession {
  cookies: string;
  csrf: string;
}

/**
 * Redeem the bootstrap invite to mint the first effective admin and return its
 * session artefacts (cookie header + CSRF token). The shared starting point for
 * every Slice 2+ test that needs an authenticated admin.
 */
export async function bootstrapAdmin(
  booted: BootedApp,
  email = 'admin@example.com',
): Promise<AdminSession> {
  const http = () => request(booted.app.getHttpServer());
  const status = await http().get('/api/bootstrap');
  const token = status.body.inviteToken as string;
  const res = await http()
    .post(`/api/invite/${token}/accept`)
    .send({
      passcode: booted.bootstrapKey,
      email,
      password: 'correct horse battery',
      displayName: 'Admin',
    });
  const setCookie = res.headers['set-cookie'] as unknown as string[];
  return {
    cookies: cookieHeader(setCookie),
    csrf: cookieValue(setCookie, 'patrice_csrf')!,
  };
}

/**
 * Create a second user via an admin-issued invite, optionally pre-assigning roles,
 * and return its session. Used by membership/scope tests.
 */
export async function inviteAndAccept(
  booted: BootedApp,
  admin: AdminSession,
  opts: { email: string; intendedRoleIds?: string[] },
): Promise<{ userId: string; session: AdminSession }> {
  const http = () => request(booted.app.getHttpServer());
  const created = await http()
    .post('/api/invitations')
    .set('Cookie', admin.cookies)
    .set('x-csrf-token', admin.csrf)
    .send({ email: opts.email, intendedRoleIds: opts.intendedRoleIds ?? [] });
  const token = created.body.token as string;
  const accepted = await http()
    .post(`/api/invite/${token}/accept`)
    .send({
      email: opts.email,
      password: 'correct horse battery',
      displayName: opts.email.split('@')[0],
    });
  const setCookie = accepted.headers['set-cookie'] as unknown as string[];
  return {
    userId: accepted.body.id as string,
    session: {
      cookies: cookieHeader(setCookie),
      csrf: cookieValue(setCookie, 'patrice_csrf')!,
    },
  };
}
