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
import { signOAuthState } from '../src/auth/oauth-state';

/**
 * Discord as an auth provider (ADR 0005): login / invite-register / link / unlink,
 * with the app-level Discord OAuth surface mocked at `global.fetch`. The signed
 * `state` is forged with the test SESSION_SECRET so we can drive the callback
 * directly without a real Discord round-trip.
 */
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-0123456789';

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
  const callback = (code: string, state: string) =>
    http().get(`/api/auth/discord/callback?code=${code}&state=${encodeURIComponent(state)}`).redirects(0);

  beforeAll(async () => {
    // Must be set before the app boots — env is read once at startup.
    process.env.DISCORD_CLIENT_ID = 'test-client-id';
    process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
    process.env.DISABLE_QUEUE = 'true';
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    // Don't leak Discord config / the fetch mock into sibling e2e files.
    global.fetch = originalFetch;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
  });

  describe('login', () => {
    it('rejects a Discord login with no matching identity (no auto-provision)', async () => {
      mockDiscordFetch();
      const state = signOAuthState(SESSION_SECRET, { intent: 'login' });
      const res = await callback('any-code', state);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_no_account');
    });
  });

  describe('register via invite', () => {
    let registeredUserId: string;

    it('mints an account + Discord sign-in identity through an invite', async () => {
      const inv = await auth(http().post('/api/invitations')).send({});
      const token = inv.body.token as string;

      mockDiscordFetch();
      const state = signOAuthState(SESSION_SECRET, { intent: 'register', inviteToken: token });
      const res = await callback('any-code', state);

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
      const state = signOAuthState(SESSION_SECRET, { intent: 'register', inviteToken: token });
      const res = await callback('any-code', state);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_already_linked');
    });
  });

  describe('login + unlink for a Discord-only user', () => {
    let cookies: string;
    let csrf: string;

    it('logs the registered Discord user in', async () => {
      mockDiscordFetch();
      const state = signOAuthState(SESSION_SECRET, { intent: 'login' });
      const res = await callback('any-code', state);
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
      const state = signOAuthState(SESSION_SECRET, { intent: 'link', userId });
      const res = await callback('any-code', state).set('Cookie', session.cookies);
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
      const state = signOAuthState(SESSION_SECRET, { intent: 'link', userId });
      const res = await callback('any-code', state); // no session cookie
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
