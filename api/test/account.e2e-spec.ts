import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { hashToken } from '../src/common/tokens';
import { QueueService } from '../src/queue/queue.service';
import {
  AdminSession,
  BootedApp,
  EmailCapture,
  bootApp,
  bootstrapAdmin,
  cookieHeader,
  cookieValue,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

const PASSWORD = 'correct horse battery';

/** Phase 1: self-service account (password, email, sessions) and token hygiene. */
describe('Account self-service', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let capture: EmailCapture;
  let prisma: PrismaClient;
  let bootstrapKey: string;
  const published: unknown[] = [];

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession, r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  async function login(email: string, password: string): Promise<AdminSession | null> {
    const res = await http().post('/api/auth/login').send({ email, password });
    if (res.status !== 200) return null;
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    return { cookies: cookieHeader(setCookie), csrf: cookieValue(setCookie, 'patrice_csrf')! };
  }

  beforeAll(async () => {
    await resetDatabase();
    const email = createEmailCapture();
    capture = email.capture;
    booted = await bootApp({ emailStub: email.stub });
    app = booted.app;
    bootstrapKey = booted.bootstrapKey!;
    const queue = app.get(QueueService);
    const publish = queue.publish.bind(queue);
    jest.spyOn(queue, 'publish').mockImplementation(async (q, data, opts) => {
      published.push(data);
      return publish(q, data, opts);
    });
    prisma = new PrismaClient();
    admin = await bootstrapAdmin(booted);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('stores the bootstrap passcode peppered, not as a bare sha256', async () => {
    const inv = await prisma.invitation.findFirstOrThrow({ where: { createdBy: null } });
    expect(inv.passcodeHash).toBe(hashToken(process.env.TOKEN_PEPPER!, bootstrapKey));
    expect(inv.passcodeHash).not.toBe(createHash('sha256').update(bootstrapKey).digest('hex'));
  });

  describe('password', () => {
    let user: { userId: string; session: AdminSession };

    beforeAll(async () => {
      user = await inviteAndAccept(booted, admin, { email: 'pw@example.com' });
    });

    it('refuses a change without the right current password', async () => {
      const res = await as(user.session, http().post('/api/me/password')).send({
        currentPassword: 'not my password',
        newPassword: 'a brand new passphrase',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WRONG_PASSWORD');
    });

    it('changes it and signs out every other session', async () => {
      const other = (await login('pw@example.com', PASSWORD))!;
      const res = await as(user.session, http().post('/api/me/password')).send({
        currentPassword: PASSWORD,
        newPassword: 'a brand new passphrase',
      });
      expect(res.status).toBe(204);
      expect((await http().get('/api/me').set('Cookie', user.session.cookies)).status).toBe(200);
      expect((await http().get('/api/me').set('Cookie', other.cookies)).status).toBe(401);
      expect(await login('pw@example.com', PASSWORD)).toBeNull();
      expect(await login('pw@example.com', 'a brand new passphrase')).not.toBeNull();
    });
  });

  describe('email change', () => {
    let user: { userId: string; session: AdminSession };

    beforeAll(async () => {
      user = await inviteAndAccept(booted, admin, { email: 'old@example.com' });
    });

    it('needs the current password', async () => {
      const res = await as(user.session, http().post('/api/me/email')).send({ newEmail: 'new@example.com' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WRONG_PASSWORD');
    });

    it('refuses an address another user has', async () => {
      const res = await as(user.session, http().post('/api/me/email')).send({
        newEmail: 'pw@example.com',
        currentPassword: PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('changes the email only once the new address confirms it', async () => {
      const res = await as(user.session, http().post('/api/me/email')).send({
        newEmail: 'new@example.com',
        currentPassword: PASSWORD,
      });
      expect(res.status).toBe(200);
      const sent = capture.emailChanges.find((e) => e.to === 'new@example.com');
      expect(sent).toBeDefined();
      // Not changed yet.
      expect(await login('old@example.com', PASSWORD)).not.toBeNull();

      const confirm = await http().post('/api/auth/email-change/confirm').send({ token: sent!.token });
      expect(confirm.status).toBe(200);
      expect(await login('old@example.com', PASSWORD)).toBeNull();
      expect(await login('new@example.com', PASSWORD)).not.toBeNull();

      const again = await http().post('/api/auth/email-change/confirm').send({ token: sent!.token });
      expect(again.status).toBe(422);
    });
  });

  describe('sessions', () => {
    let user: { userId: string; session: AdminSession };

    beforeAll(async () => {
      user = await inviteAndAccept(booted, admin, { email: 'sessions@example.com' });
    });

    it('lists your sessions and marks the current one', async () => {
      await login('sessions@example.com', PASSWORD);
      const res = await http().get('/api/me/sessions').set('Cookie', user.session.cookies);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    });

    it('signs out one of your own sessions without any grant', async () => {
      const list = await http().get('/api/me/sessions').set('Cookie', user.session.cookies);
      const other = list.body.find((s: { current: boolean }) => !s.current);
      const res = await as(user.session, http().delete(`/api/sessions/${other.id}`));
      expect(res.status).toBe(204);
      const after = await http().get('/api/me/sessions').set('Cookie', user.session.cookies);
      expect(after.body).toHaveLength(1);
    });

    it("needs session:revoke to see or end someone else's sessions", async () => {
      const mine = await http().get('/api/me/sessions').set('Cookie', admin.cookies);
      const adminSession = mine.body[0].id as string;
      // A user without the grant can't touch anyone else's sessions…
      expect((await as(user.session, http().delete(`/api/sessions/${adminSession}`))).status).toBe(403);
      const me = await http().get('/api/me').set('Cookie', admin.cookies);
      expect((await http().get(`/api/users/${me.body.id}/sessions`).set('Cookie', user.session.cookies)).status).toBe(403);

      // …while Admin (seeded with every action) can.
      const theirs = await http().get(`/api/users/${user.userId}/sessions`).set('Cookie', admin.cookies);
      expect(theirs.status).toBe(200);
      const res = await as(admin, http().delete(`/api/sessions/${theirs.body[0].id}`));
      expect(res.status).toBe(204);
      expect((await http().get('/api/me').set('Cookie', user.session.cookies)).status).toBe(401);
      const audit = await prisma.activity.findFirst({ where: { verb: 'session.revoked', subjectId: theirs.body[0].id } });
      expect(audit).toBeTruthy();
    });
  });

  describe('single-use tokens', () => {
    it('two concurrent confirms of one verification token: exactly one succeeds', async () => {
      await inviteAndAccept(booted, admin, { email: 'race@example.com' });
      const token = capture.lastVerificationToken('race@example.com')!;
      const [a, b] = await Promise.all([
        http().post('/api/auth/verify-email/confirm').send({ token }),
        http().post('/api/auth/verify-email/confirm').send({ token }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 422]);
    });

    it('no queued job ever carries a mailed token', async () => {
      await http().post('/api/auth/password-reset').send({ email: 'race@example.com' });
      const tokens = [...capture.verifications, ...capture.resets, ...capture.emailChanges].map((e) => e.token);
      expect(tokens.length).toBeGreaterThan(0);
      const payloads = JSON.stringify(published);
      for (const t of tokens) expect(payloads).not.toContain(t);
    });
  });
});
