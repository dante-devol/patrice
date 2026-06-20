/* eslint-disable */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  BootedApp,
  bootApp,
  cookieHeader,
  cookieValue,
  resetDatabase,
} from './helpers';

/**
 * Slice 1 acceptance + authz + invitation + session tests
 * (docs/slices/01 "Tests (must pass)").
 */
describe('Slice 1 — Foundation, Auth, Engine & Bootstrap', () => {
  let booted: BootedApp;
  let app: INestApplication;

  // Admin session artefacts captured after bootstrap.
  let adminCookies: string;
  let adminCsrf: string;

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp();
    app = booted.app;
  });

  afterAll(async () => {
    await app?.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  it('prints a bootstrap key on an empty DB (no effective admin)', () => {
    expect(booted.bootstrapKey).toBeTruthy();
  });

  it('GET /health pings the DB', async () => {
    const res = await http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('GET /bootstrap reports open with an invite token', async () => {
    const res = await http().get('/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(true);
    expect(typeof res.body.inviteToken).toBe('string');
  });

  it('accepts the bootstrap invite → first admin, httpOnly session cookie', async () => {
    const status = await http().get('/bootstrap');
    const token = status.body.inviteToken as string;

    const res = await http()
      .post(`/invite/${token}/accept`)
      .send({
        passcode: booted.bootstrapKey,
        email: 'admin@example.com',
        password: 'correct horse battery',
        displayName: 'Admin',
      });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('admin@example.com');

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const sessionCookie = setCookie.find((c) => c.startsWith('patrice_session='));
    expect(sessionCookie).toMatch(/HttpOnly/i);

    adminCookies = cookieHeader(setCookie);
    adminCsrf = cookieValue(setCookie, 'patrice_csrf')!;
    expect(adminCsrf).toBeTruthy();
  });

  it('GET /me returns the authenticated admin (email auto-verified)', async () => {
    const res = await http().get('/me').set('Cookie', adminCookies);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('admin@example.com');
    expect(res.body.emailVerified).toBe(true); // bootstrap auto-verifies
  });

  it('GET /bootstrap now reports closed (effective admin exists)', async () => {
    const res = await http().get('/bootstrap');
    expect(res.body.open).toBe(false);
  });

  it('admin can POST /invitations (holds invite:create) → 201', async () => {
    const res = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({ email: 'base@example.com' });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
  });

  it('GET /invite/:token does NOT consume the invite', async () => {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({});
    const token = created.body.token as string;

    await http().get(`/invite/${token}`);
    await http().get(`/invite/${token}`);

    const view = await http().get(`/invite/${token}`);
    expect(view.body.status).toBe('pending'); // still redeemable
  });

  it('a base user (no grants) is denied POST /invitations → 403', async () => {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({ email: 'nobody@example.com' });
    const token = created.body.token as string;

    const accept = await http()
      .post(`/invite/${token}/accept`)
      .send({
        email: 'nobody@example.com',
        password: 'another good passphrase',
        displayName: 'Base User',
      });
    expect(accept.status).toBe(201);

    const baseSetCookie = accept.headers['set-cookie'] as unknown as string[];
    const baseCookies = cookieHeader(baseSetCookie);
    const baseCsrf = cookieValue(baseSetCookie, 'patrice_csrf')!;

    const denied = await http()
      .post('/invitations')
      .set('Cookie', baseCookies)
      .set('x-csrf-token', baseCsrf)
      .send({ email: 'x@example.com' });
    expect(denied.status).toBe(403); // ← proves the engine gates the action
  });

  it('a revoked invite cannot be redeemed → 410', async () => {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({});
    const { id, token } = created.body;

    const rev = await http()
      .post(`/invitations/${id}/revoke`)
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf);
    expect(rev.status).toBe(204);

    const accept = await http()
      .post(`/invite/${token}/accept`)
      .send({ email: 'r@example.com', password: 'passphrase here ok', displayName: 'R' });
    expect(accept.status).toBe(410);
  });

  it('an expired invite cannot be redeemed → 410', async () => {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const token = created.body.token as string;

    const accept = await http()
      .post(`/invite/${token}/accept`)
      .send({ email: 'e@example.com', password: 'passphrase here ok', displayName: 'E' });
    expect(accept.status).toBe(410);
  });

  it('FCFS single-use: concurrent accepts → exactly one wins', async () => {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({});
    const token = created.body.token as string;

    const [a, b] = await Promise.all([
      http()
        .post(`/invite/${token}/accept`)
        .send({ email: 'race1@example.com', password: 'passphrase here ok', displayName: 'One' }),
      http()
        .post(`/invite/${token}/accept`)
        .send({ email: 'race2@example.com', password: 'passphrase here ok', displayName: 'Two' }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one wins (201). The loser is rejected either at the atomic update
    // (409) or because its pre-read already saw the invite exhausted (410) —
    // both are correct "did not win" outcomes depending on commit timing.
    expect(statuses[0]).toBe(201);
    expect([409, 410]).toContain(statuses[1]);
  });

  it('logout revokes the session (subsequent /me → 401)', async () => {
    // Fresh login for an isolated session.
    const login = await http()
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const cookies = cookieHeader(setCookie);
    const csrf = cookieValue(setCookie, 'patrice_csrf')!;

    const me1 = await http().get('/me').set('Cookie', cookies);
    expect(me1.status).toBe(200);

    const out = await http()
      .post('/auth/logout')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf);
    expect(out.status).toBe(204);

    const me2 = await http().get('/me').set('Cookie', cookies);
    expect(me2.status).toBe(401);
  });

  async function freshInviteToken(): Promise<string> {
    const created = await http()
      .post('/invitations')
      .set('Cookie', adminCookies)
      .set('x-csrf-token', adminCsrf)
      .send({});
    return created.body.token as string;
  }

  it('rejects a too-short password with a specific, field-targeted message', async () => {
    const token = await freshInviteToken();
    const res = await http()
      .post(`/invite/${token}/accept`)
      .send({ email: 'shortpw@example.com', password: 'short', displayName: 'X' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/at least 8 characters/i);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'password' })]),
    );
  });

  it('rejects an invalid email with a specific message', async () => {
    const token = await freshInviteToken();
    const res = await http()
      .post(`/invite/${token}/accept`)
      .send({ email: 'not-an-email', password: 'a valid passphrase', displayName: 'X' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/valid email/i);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'email' })]),
    );
  });

  it('rejects a duplicate email with a clear "already exists" message', async () => {
    const token = await freshInviteToken();
    const res = await http()
      .post(`/invite/${token}/accept`)
      .send({
        email: 'admin@example.com', // already registered as the bootstrap admin
        password: 'a valid passphrase',
        displayName: 'Impostor',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/already exists/i);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'email' })]),
    );
  });

  it('there is no open sign-up path (registration only via invite accept)', async () => {
    const res = await http()
      .post('/auth/register')
      .send({ email: 'sneaky@example.com', password: 'passphrase here ok' });
    expect(res.status).toBe(404);
  });

  it('a restart with an admin present prints NO bootstrap key', async () => {
    const second = await bootApp();
    try {
      expect(second.bootstrapKey).toBeNull();
    } finally {
      await second.app.close();
    }
  });
});
