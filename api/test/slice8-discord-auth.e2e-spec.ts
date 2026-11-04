import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  cookieHeader,
  cookieValue,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';
import { encryptOAuthSecret } from '../src/auth/oauth-secret.cipher';

/**
 * Discord as an auth provider (ADR 0005): login / invite-register / link / unlink,
 * with the app-level Discord OAuth surface mocked at `global.fetch`. Each flow is
 * started through the real endpoint, which redirects to Discord with a `state` and
 * sets the browser's nonce cookie; the test then plays Discord's redirect back.
 */

const DISCORD_USER = {
  id: '900900900900900900',
  username: 'tester',
  global_name: 'Tester',
  avatar: 'avatarhash123',
  email: 'discord-tester@example.com',
};

type DiscordUser = typeof DISCORD_USER;

const fakeRes = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function mockDiscordFetch(user: DiscordUser = DISCORD_USER): void {
  global.fetch = jest.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/oauth2/token')) return fakeRes(200, { access_token: 'fake-access' });
    if (u.includes('/users/@me')) return fakeRes(200, user);
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch;
}

describe('Slice 8 — Discord auth (login / register / link)', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  const originalFetch = global.fetch;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  /** Start a flow; returns the `state` sent to Discord and the nonce cookie set. */
  async function start(path: string, cookies?: string): Promise<{ state: string; nonce: string }> {
    let req = http().get(path).redirects(0);
    if (cookies) req = req.set('Cookie', cookies);
    const res = await req;
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).toBe('discord.com');
    const nonce = cookieValue(res.headers['set-cookie'] as unknown as string[], 'patrice_oauth');
    return { state: location.searchParams.get('state')!, nonce: nonce! };
  }

  /** Discord's redirect back, in a browser holding `cookies` (the nonce, a session…). */
  const callback = (code: string, state: string, cookies = '') =>
    http()
      .get(`/api/auth/discord/callback?code=${code}&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies)
      .redirects(0);
  const nonceCookie = (nonce: string) => `patrice_oauth=${nonce}`;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    // Discord OAuth app is runtime config now (ADR 0006), not env — an admin sets it.
    await auth(http().patch('/api/config')).send({
      discordClientId: 'test-client-id',
      discordClientSecret: 'test-client-secret',
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    global.fetch = originalFetch; // don't leak the fetch mock into sibling e2e files
  });

  describe('runtime config (ADR 0006)', () => {
    it('GET /config reports configured but never returns the secret', async () => {
      const res = await auth(http().get('/api/config'));
      expect(res.status).toBe(200);
      expect(res.body.discordClientId).toBe('test-client-id');
      expect(res.body.discordOAuthConfigured).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('test-client-secret');
      expect(res.body).not.toHaveProperty('discordClientSecret');
    });

    it('stores the client secret encrypted under SECRETS_KEY (sec1: handle)', async () => {
      const secret = await prisma.secret.findUniqueOrThrow({
        where: { purpose: 'discord_oauth_client_secret' },
      });
      expect(secret.ciphertext.startsWith('sec1:')).toBe(true);
      expect(secret.ciphertext).not.toContain('test-client-secret');
    });

    it('re-encrypts a legacy SESSION_SECRET-keyed secret on first use', async () => {
      await prisma.secret.update({
        where: { purpose: 'discord_oauth_client_secret' },
        data: { ciphertext: encryptOAuthSecret(process.env.SESSION_SECRET!, 'test-client-secret') },
      });
      // Starting a flow reads the secret, which upgrades it in place.
      const res = await http().get('/api/auth/discord/login').redirects(0);
      expect(new URL(res.headers.location as string).host).toBe('discord.com');
      const secret = await prisma.secret.findUniqueOrThrow({
        where: { purpose: 'discord_oauth_client_secret' },
      });
      expect(secret.ciphertext.startsWith('sec1:')).toBe(true);
    });
  });

  describe('login', () => {
    it('rejects a Discord login with no matching identity (no auto-provision)', async () => {
      mockDiscordFetch();
      const { state, nonce } = await start('/api/auth/discord/login');
      const res = await callback('any-code', state, nonceCookie(nonce));
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_no_account');
    });

    it("rejects an attacker's callback opened in a victim's browser (login CSRF)", async () => {
      mockDiscordFetch();
      // The attacker starts a flow in their own browser and captures the callback URL…
      const { state } = await start('/api/auth/discord/login');
      // …but the victim's browser never received the attacker's nonce cookie.
      const res = await callback('attacker-code', state);
      expect(res.headers.location).toContain('discord_state');
      expect(res.headers['set-cookie']?.toString() ?? '').not.toContain('patrice_session');
    });

    it('a flow can be completed only once', async () => {
      mockDiscordFetch();
      const { state, nonce } = await start('/api/auth/discord/login');
      await callback('any-code', state, nonceCookie(nonce));
      const replay = await callback('any-code', state, nonceCookie(nonce));
      expect(replay.headers.location).toContain('discord_state');
    });

    it('a nonce from a different flow does not unlock this one', async () => {
      mockDiscordFetch();
      const mine = await start('/api/auth/discord/login');
      const theirs = await start('/api/auth/discord/login');
      const res = await callback('any-code', mine.state, nonceCookie(theirs.nonce));
      expect(res.headers.location).toContain('discord_state');
    });
  });

  describe('register via invite', () => {
    let registeredUserId: string;

    it('mints an account + Discord sign-in identity through an invite', async () => {
      const inv = await auth(http().post('/api/invitations')).send({});
      const token = inv.body.token as string;

      mockDiscordFetch();
      const { state, nonce } = await start(`/api/auth/discord/register?invite=${token}`);
      // The invite token never travels through Discord.
      expect(state).not.toContain(token);
      expect(Buffer.from(state, 'base64url').toString('latin1')).not.toContain(token);
      const res = await callback('any-code', state, nonceCookie(nonce));

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/home');
      expect(res.headers['set-cookie']).toBeDefined();

      const identity = await prisma.userIdentity.findFirst({
        where: { provider: 'discord', providerSubject: DISCORD_USER.id },
      });
      expect(identity).toBeTruthy();
      registeredUserId = identity!.userId;

      // OAuth identities start verified; no password identity exists.
      expect(identity!.verifiedAt).not.toBeNull();
      const pw = await prisma.userIdentity.findFirst({
        where: { userId: registeredUserId, provider: 'password' },
      });
      expect(pw).toBeNull();
    });

    it('a second account cannot claim the same Discord identity', async () => {
      const inv = await auth(http().post('/api/invitations')).send({});
      const token = inv.body.token as string;
      mockDiscordFetch();
      const { state, nonce } = await start(`/api/auth/discord/register?invite=${token}`);
      const res = await callback('any-code', state, nonceCookie(nonce));
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_already_linked');
    });
  });

  describe('login + unlink for a Discord-only user', () => {
    let cookies: string;
    let csrf: string;

    it('logs the registered Discord user in', async () => {
      mockDiscordFetch();
      const { state, nonce } = await start('/api/auth/discord/login');
      const res = await callback('any-code', state, nonceCookie(nonce));
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/home');
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      cookies = cookieHeader(setCookie);
      csrf = cookieValue(setCookie, 'patrice_csrf')!;
      expect(cookies).toContain('patrice_session');
    });

    it('refuses to unlink Discord when it is the only sign-in method', async () => {
      const res = await http()
        .delete('/api/auth/discord')
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_AUTH_METHOD');
    });
    it('adds a password (no current password needed), then can disconnect Discord', async () => {
      const set = await http()
        .post('/api/me/password')
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf)
        .send({ newPassword: 'a discord user passphrase' });
      expect(set.status).toBe(204);
      const unlink = await http()
        .delete('/api/auth/discord')
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf);
      expect(unlink.status).toBe(200);
      expect(unlink.body.authMethods).toEqual(['password']);
      const relogin = await http()
        .post('/api/auth/login')
        .send({ email: DISCORD_USER.email, password: 'a discord user passphrase' });
      expect(relogin.status).toBe(200);
    });
  });

  describe('authenticated link / unlink for a password user', () => {
    let userId: string;
    let session: AdminSession;

    beforeAll(async () => {
      const r = await inviteAndAccept(booted, admin, { email: 'pwuser@example.com' });
      userId = r.userId;
      session = r.session;
      // An active connection so the link also creates an external_identity.
      await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'guild-link-test',
        displayName: 'Link Guild',
        config: { botToken: 'Bot.x' },
      });
    });

    it('connects Discord: creates a sign-in identity + integration link + avatar', async () => {
      const linkUser: DiscordUser = {
        id: '111111111111111111',
        username: 'pwuser',
        global_name: 'PW User',
        avatar: 'pwavatar',
        email: 'pwuser-discord@example.com',
      };
      mockDiscordFetch(linkUser);
      const { state, nonce } = await start('/api/auth/discord/link', session.cookies);
      const res = await callback('any-code', state, `${session.cookies}; ${nonceCookie(nonce)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/account?linked=1');

      const id = await prisma.userIdentity.findFirst({
        where: { userId, provider: 'discord' },
      });
      expect(id).toBeTruthy();
      const ext = await prisma.externalIdentity.findFirst({ where: { userId } });
      expect(ext).toBeTruthy();
      expect(ext!.externalAvatarHash).toBe('pwavatar');
    });

    it('a link callback without a session is rejected', async () => {
      mockDiscordFetch();
      const { state, nonce } = await start('/api/auth/discord/link', session.cookies);
      const res = await callback('any-code', state, nonceCookie(nonce)); // no session cookie
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_session');
    });

    it('disconnects Discord (password remains as fallback)', async () => {
      const res = await http()
        .delete('/api/auth/discord')
        .set('Cookie', session.cookies)
        .set('x-csrf-token', session.csrf);
      expect(res.status).toBe(200);
      expect(res.body.authMethods).toEqual(['password']);
      const id = await prisma.userIdentity.findFirst({
        where: { userId, provider: 'discord' },
      });
      expect(id).toBeNull();
      const ext = await prisma.externalIdentity.findFirst({ where: { userId } });
      expect(ext).toBeNull();
    });
  });
});
