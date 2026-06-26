import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/**
 * Slice 8 — Integrations (Discord): connection CRUD, account linking, role mapping,
 * sync trigger, GC extension, requireDiscordLink gate, auth isolation.
 */
describe('Slice 8 — Integrations', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  beforeAll(async () => {
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
  });

  // ---------------------------------------------------------------------------
  // 8.1 — Connection CRUD
  // ---------------------------------------------------------------------------

  describe('8.1 — connection CRUD', () => {
    let connectionId: string;

    it('connects a Discord guild', async () => {
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: '111222333444555666',
        displayName: 'Test Guild',
        config: { botToken: 'Bot.test.token' },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        provider: 'discord',
        externalWorkspaceId: '111222333444555666',
        displayName: 'Test Guild',
        status: 'active',
        lifecycleState: 'active',
      });
      connectionId = res.body.id as string;
    });

    it('encrypts the bot token at rest on connect (no plaintext in config)', async () => {
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: '900900900900900900',
        displayName: 'Encrypted Guild',
        config: { botToken: 'Bot.SUPER.SECRET.encme' },
      });
      expect(res.status).toBe(201);
      const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: res.body.id } });
      // Token moved out of config into an encrypted credentials_ref handle.
      expect((row.config as Record<string, unknown>).botToken).toBeUndefined();
      expect(row.credentialsRef).toMatch(/^aead:/);
      expect(JSON.stringify(row.config)).not.toContain('encme');
      await prisma.integrationConnection.delete({ where: { id: res.body.id } });
    });

    it('rejects duplicate workspace connection', async () => {
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: '111222333444555666',
        displayName: 'Duplicate',
        config: {},
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_CONNECTION');
    });

    it('lists connections (default excludes retired)', async () => {
      const res = await auth(http().get('/api/integrations'));
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: string }) => c.id)).toContain(connectionId);
    });

    it('updates display name', async () => {
      const res = await auth(http().patch(`/api/integrations/${connectionId}`)).send({
        displayName: 'Renamed Guild',
      });
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe('Renamed Guild');
    });

    it('retires a connection', async () => {
      const res = await auth(http().post(`/api/integrations/${connectionId}/retire`));
      expect(res.status).toBe(200);
      expect(res.body.lifecycleState).toBe('retired');
    });

    it('retired connection excluded from default list', async () => {
      const res = await auth(http().get('/api/integrations'));
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: string }) => c.id)).not.toContain(connectionId);
    });

    it('included when ?include=retired', async () => {
      const res = await auth(http().get('/api/integrations?include=retired'));
      expect(res.status).toBe(200);
      expect(res.body.map((c: { id: string }) => c.id)).toContain(connectionId);
    });

    it('revives within grace window', async () => {
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
      const res = await auth(http().post(`/api/integrations/${connectionId}/revive`));
      expect(res.status).toBe(200);
      expect(res.body.lifecycleState).toBe('active');
    });

    it('revive past grace → 409 NOT_REVIVABLE', async () => {
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      await auth(http().post(`/api/integrations/${connectionId}/retire`));
      const res = await auth(http().post(`/api/integrations/${connectionId}/revive`));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_REVIVABLE');
      // restore for later tests
      await prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { lifecycleState: 'active', retiredAt: null },
      });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });
  });

  // ---------------------------------------------------------------------------
  // 8.2 — Account linking
  // ---------------------------------------------------------------------------

  describe('8.2 — account linking', () => {
    let connectionId: string;
    let userId: string;

    beforeAll(async () => {
      const conn = await prisma.integrationConnection.findFirst({
        where: { lifecycleState: 'active' },
      });
      connectionId = conn!.id;
      const { userId: uid } = await inviteAndAccept(booted, admin, {
        email: 'member@example.com',
      });
      userId = uid;
    });

    it('GET /auth/discord/login redirects to an error when Discord is not configured', async () => {
      // No DISCORD_CLIENT_ID in this app → the start route redirects (full-page nav),
      // never a JSON 422 the user would never see.
      const res = await http().get('/api/auth/discord/login').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('discord_not_configured');
    });

    it('stores an external_identity row directly (simulates callback)', async () => {
      const identity = await prisma.externalIdentity.create({
        data: {
          userId,
          connectionId,
          externalUserId: '777888999000111222',
          externalHandle: 'testuser#0001',
        },
      });
      expect(identity.userId).toBe(userId);
      expect(identity.connectionId).toBe(connectionId);
    });

    it('enforces unique (userId, connectionId) — second link attempt rejected by DB', async () => {
      await expect(
        prisma.externalIdentity.create({
          data: {
            userId,
            connectionId,
            externalUserId: 'different-snowflake',
          },
        }),
      ).rejects.toThrow();
    });

    it('enforces unique (connectionId, externalUserId)', async () => {
      const otherUser = await prisma.appUser.findFirst({
        where: { email: 'admin@example.com' },
      });
      await expect(
        prisma.externalIdentity.create({
          data: {
            userId: otherUser!.id,
            connectionId,
            externalUserId: '777888999000111222', // same Discord ID
          },
        }),
      ).rejects.toThrow();
    });

    it('/me reflects hasDiscordLink=true after linking', async () => {
      // log in as the member
      const loginRes = await http().post('/api/auth/login').send({
        email: 'member@example.com',
        password: 'correct horse battery',
      });
      const setCookie = loginRes.headers['set-cookie'] as unknown as string[];
      const cookies = setCookie.map((c: string) => c.split(';')[0]).join('; ');
      const csrf = setCookie
        .map((c: string) => c.match(/patrice_csrf=([^;]+)/)?.[1])
        .find(Boolean) ?? '';

      const meRes = await http()
        .get('/api/me')
        .set('Cookie', cookies)
        .set('x-csrf-token', csrf);
      expect(meRes.status).toBe(200);
      expect(meRes.body.hasDiscordLink).toBe(true);
    });

    it('/me reflects hasDiscordLink=false for an unlinked user', async () => {
      const meRes = await auth(http().get('/api/me'));
      // admin has no external_identity
      expect(meRes.status).toBe(200);
      expect(meRes.body.hasDiscordLink).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8.3 — Role↔group mapping
  // ---------------------------------------------------------------------------

  describe('8.3 — role mappings', () => {
    let connectionId: string;
    let roleId: string;
    let mappingId: string;

    beforeAll(async () => {
      const conn = await prisma.integrationConnection.findFirst({
        where: { lifecycleState: 'active' },
      });
      connectionId = conn!.id;
      const roleRes = await auth(http().post('/api/roles')).send({ name: 'Discord Member' });
      roleId = roleRes.body.id as string;
    });

    it('creates a mapping by stable snowflake ID', async () => {
      const res = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({
        roleId,
        externalGroupId: '999000111222333444', // stable Discord role snowflake
        syncDirection: 'inbound',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        roleId,
        connectionId,
        externalGroupId: '999000111222333444',
        syncDirection: 'inbound',
        isBroken: false,
      });
      mappingId = res.body.id as string;
    });

    it('rejects duplicate mapping', async () => {
      const res = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({
        roleId,
        externalGroupId: '999000111222333444',
        syncDirection: 'outbound',
      });
      expect(res.status).toBe(409);
    });

    it('lists mappings for a connection', async () => {
      const res = await auth(
        http().get(`/api/integrations/${connectionId}/mappings`),
      );
      expect(res.status).toBe(200);
      expect(res.body.map((m: { id: string }) => m.id)).toContain(mappingId);
    });

    it('updates sync direction', async () => {
      const res = await auth(
        http().patch(`/api/integrations/${connectionId}/mappings/${mappingId}`),
      ).send({ syncDirection: 'bidirectional' });
      expect(res.status).toBe(200);
      expect(res.body.syncDirection).toBe('bidirectional');
    });

    it('rejects mapping a retired role', async () => {
      await auth(http().post(`/api/roles/${roleId}/retire`));
      const res = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({
        roleId,
        externalGroupId: 'new-snowflake',
        syncDirection: 'inbound',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('ROLE_RETIRED');
      await auth(http().post(`/api/roles/${roleId}/revive`));
    });

    it('stable ID: snowflake survives a Discord role rename (mapping unchanged)', async () => {
      // The mapping stores the snowflake — a rename on Discord's side changes
      // nothing here. The adapter uses the ID, not the name. We verify the ID
      // is stored correctly (name is irrelevant to the mapping row).
      const row = await prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
      expect(row?.externalGroupId).toBe('999000111222333444');
      // A "rename" would only affect the Discord API side; our row is intact.
    });

    it('is_broken can be set (simulating deleted Discord role)', async () => {
      await prisma.externalGroupMapping.update({
        where: { id: mappingId },
        data: { isBroken: true },
      });
      const row = await prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
      expect(row?.isBroken).toBe(true);
      // reset
      await prisma.externalGroupMapping.update({
        where: { id: mappingId },
        data: { isBroken: false },
      });
    });

    it('deletes a mapping', async () => {
      const res = await auth(
        http().delete(`/api/integrations/${connectionId}/mappings/${mappingId}`),
      );
      expect(res.status).toBe(204);
      const row = await prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 8.4 — Sync trigger
  // ---------------------------------------------------------------------------

  describe('8.4 — sync trigger', () => {
    it('POST /integrations/:id/sync returns 202 queued:true', async () => {
      const conn = await prisma.integrationConnection.findFirst({
        where: { lifecycleState: 'active' },
      });
      const res = await auth(http().post(`/api/integrations/${conn!.id}/sync`));
      expect(res.status).toBe(202);
      expect(res.body.queued).toBe(true);
    });

    it('POST /integrations/:id/sync on retired connection → 404', async () => {
      const conn = await prisma.integrationConnection.create({
        data: {
          organizationId: (await prisma.organization.findFirstOrThrow()).id,
          provider: 'discord',
          externalWorkspaceId: 'retired-guild',
          displayName: 'Gone Guild',
          lifecycleState: 'retired',
          retiredAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const res = await auth(http().post(`/api/integrations/${conn.id}/sync`));
      // loadActive throws 404 for non-active connections
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // 8.4 — GC extension
  // ---------------------------------------------------------------------------

  describe('8.4 — GC extension', () => {
    it('user scrub deletes external_identity rows', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const conn = await prisma.integrationConnection.findFirst({
        where: { lifecycleState: 'active' },
      });
      // Create a throwaway user and link them
      const { userId: scrubUserId } = await inviteAndAccept(booted, admin, {
        email: 'to-scrub@example.com',
      });
      await prisma.externalIdentity.create({
        data: {
          userId: scrubUserId,
          connectionId: conn!.id,
          externalUserId: 'scrub-discord-id',
        },
      });
      expect(await prisma.externalIdentity.count({ where: { userId: scrubUserId } })).toBe(1);

      // Force the user into a past-grace retired state then run GC.
      await prisma.appUser.update({
        where: { id: scrubUserId },
        data: { lifecycleState: 'retired', retiredAt: new Date(0) },
      });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      const sweep = await auth(http().post('/api/gc/sweep'));
      expect(sweep.status).toBe(200);
      expect(
        sweep.body.usersScrubbed.includes(scrubUserId) ||
          sweep.body.usersDeleted.includes(scrubUserId),
      ).toBe(true);

      // The external_identity must be gone.
      expect(await prisma.externalIdentity.count({ where: { userId: scrubUserId } })).toBe(0);
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });

    it('retired-past-grace connection with no refs is GC-collected', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const conn = await prisma.integrationConnection.create({
        data: {
          organizationId: orgId,
          provider: 'discord',
          externalWorkspaceId: 'gc-test-guild',
          displayName: 'GC Target',
          lifecycleState: 'retired',
          retiredAt: new Date(0), // well past any grace window
          updatedAt: new Date(),
        },
      });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      const sweep = await auth(http().post('/api/gc/sweep'));
      expect(sweep.status).toBe(200);
      expect(sweep.body.integrationConnections).toContain(conn.id);

      const row = await prisma.integrationConnection.findUnique({ where: { id: conn.id } });
      expect(row).toBeNull();
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });

    it('dry-run reports collectable connections', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const conn = await prisma.integrationConnection.create({
        data: {
          organizationId: orgId,
          provider: 'discord',
          externalWorkspaceId: 'dry-run-guild',
          displayName: 'Dry Run Target',
          lifecycleState: 'retired',
          retiredAt: new Date(0),
          updatedAt: new Date(),
        },
      });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      const dry = await auth(http().post('/api/gc/sweep/dry-run'));
      expect(dry.status).toBe(200);
      expect(dry.body.integrationConnections).toContain(conn.id);
      await prisma.integrationConnection.delete({ where: { id: conn.id } });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });

    it('connection with live external_identity blocked from GC', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const conn = await prisma.integrationConnection.create({
        data: {
          organizationId: orgId,
          provider: 'discord',
          externalWorkspaceId: 'referenced-guild',
          displayName: 'Referenced Guild',
          lifecycleState: 'retired',
          retiredAt: new Date(0),
          updatedAt: new Date(),
        },
      });
      const memberUser = await prisma.appUser.findFirst({ where: { email: 'member@example.com' } });
      // Give member a distinct link to this connection
      await prisma.externalIdentity.create({
        data: {
          userId: memberUser!.id,
          connectionId: conn.id,
          externalUserId: 'blocked-discord-id',
        },
      });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      const sweep = await auth(http().post('/api/gc/sweep'));
      // Not collected because external_identity still references it.
      expect(sweep.body.integrationConnections ?? []).not.toContain(conn.id);
      // Cleanup
      await prisma.externalIdentity.deleteMany({ where: { connectionId: conn.id } });
      await prisma.integrationConnection.delete({ where: { id: conn.id } });
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });
  });

  // ---------------------------------------------------------------------------
  // Auth isolation — integration state never affects login
  // ---------------------------------------------------------------------------

  describe('auth isolation', () => {
    it('login succeeds with no integration configured', async () => {
      const res = await http()
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'correct horse battery' });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
    });

    it('login succeeds when connection is broken', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const broken = await prisma.integrationConnection.create({
        data: {
          organizationId: orgId,
          provider: 'discord',
          externalWorkspaceId: 'broken-guild',
          displayName: 'Broken',
          status: 'broken',
          updatedAt: new Date(),
        },
      });
      const res = await http()
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'correct horse battery' });
      expect(res.status).toBe(200);
      await prisma.integrationConnection.delete({ where: { id: broken.id } });
    });

    it('login succeeds when user has no Discord link', async () => {
      // admin has no external_identity — login must still work
      const res = await http()
        .post('/api/auth/login')
        .send({ email: 'admin@example.com', password: 'correct horse battery' });
      expect(res.status).toBe(200);
      expect(res.body.hasDiscordLink).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8.5 — Secret redaction (issue #55)
  // ---------------------------------------------------------------------------

  describe('8.5 — secret redaction', () => {
    let secretConnId: string;

    beforeAll(async () => {
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'secret-guild-111',
        displayName: 'Secret Guild',
        config: { botToken: 'Bot.secret.token.DO_NOT_LEAK' },
        credentialsRef: 'aead:ciphertext-DO_NOT_LEAK',
      });
      secretConnId = res.body.id as string;
    });

    const noSecret = (body: unknown) => {
      const json = JSON.stringify(body);
      expect(json).not.toContain('DO_NOT_LEAK');
      expect(json).not.toContain('botToken');
      expect(json).not.toContain('credentialsRef');
      expect(json).not.toContain('credentials_ref');
    };

    it('POST /integrations response omits config and credentialsRef', async () => {
      // already created in beforeAll; check that response body itself was clean
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'secret-guild-222',
        displayName: 'Secret Guild 2',
        config: { botToken: 'Bot.secret.2.DO_NOT_LEAK' },
      });
      expect(res.status).toBe(201);
      noSecret(res.body);
      expect(res.body).not.toHaveProperty('config');
      expect(res.body).not.toHaveProperty('credentialsRef');
      await prisma.integrationConnection.delete({ where: { id: res.body.id as string } });
    });

    it('GET /integrations list omits config and credentialsRef', async () => {
      const res = await auth(http().get('/api/integrations'));
      expect(res.status).toBe(200);
      noSecret(res.body);
      for (const conn of res.body as unknown[]) {
        expect(conn).not.toHaveProperty('config');
        expect(conn).not.toHaveProperty('credentialsRef');
      }
    });

    it('PATCH /integrations/:id omits config and credentialsRef', async () => {
      const res = await auth(http().patch(`/api/integrations/${secretConnId}`)).send({
        displayName: 'Secret Guild Renamed',
      });
      expect(res.status).toBe(200);
      noSecret(res.body);
      expect(res.body).not.toHaveProperty('config');
      expect(res.body).not.toHaveProperty('credentialsRef');
    });

    it('POST /integrations/:id/retire omits config and credentialsRef', async () => {
      const res = await auth(http().post(`/api/integrations/${secretConnId}/retire`));
      expect(res.status).toBe(200);
      noSecret(res.body);
      expect(res.body).not.toHaveProperty('config');
      expect(res.body).not.toHaveProperty('credentialsRef');
    });

    it('POST /integrations/:id/revive omits config and credentialsRef', async () => {
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
      const res = await auth(http().post(`/api/integrations/${secretConnId}/revive`));
      expect(res.status).toBe(200);
      noSecret(res.body);
      expect(res.body).not.toHaveProperty('config');
      expect(res.body).not.toHaveProperty('credentialsRef');
    });
  });

  // ---------------------------------------------------------------------------
  // requireDiscordLink setting
  // ---------------------------------------------------------------------------

  describe('requireDiscordLink config', () => {
    it('GET /config returns requireDiscordLink=false by default', async () => {
      const res = await auth(http().get('/api/config'));
      expect(res.status).toBe(200);
      expect(res.body.requireDiscordLink).toBe(false);
    });

    it('PATCH /config can enable requireDiscordLink', async () => {
      const res = await auth(http().patch('/api/config')).send({
        requireDiscordLink: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.requireDiscordLink).toBe(true);
    });

    it('PATCH /config can disable requireDiscordLink', async () => {
      const res = await auth(http().patch('/api/config')).send({
        requireDiscordLink: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.requireDiscordLink).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8.6 — Admin observability + safety surfaces
  // ---------------------------------------------------------------------------

  describe('8.6 — observability & safety', () => {
    let connectionId: string;

    beforeAll(async () => {
      const conn = await prisma.integrationConnection.findFirst({
        where: { lifecycleState: 'active' },
      });
      connectionId = conn!.id;
    });

    it('connection list carries gateway + sync observability fields', async () => {
      const res = await auth(http().get('/api/integrations'));
      expect(res.status).toBe(200);
      const conn = (res.body as Array<Record<string, unknown>>).find((c) => c.id === connectionId);
      expect(conn).toBeDefined();
      expect(conn).toHaveProperty('gatewayState');
      expect(conn).toHaveProperty('syncState');
      expect(conn).toHaveProperty('lastSyncAt');
      expect(conn).toHaveProperty('nextReconcileAt');
      expect(conn).toHaveProperty('lastError');
      // Still never leaks secrets.
      expect(conn).not.toHaveProperty('config');
      expect(conn).not.toHaveProperty('credentialsRef');
    });

    it('Native-Authority Carve-Out: cannot map a governance role', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const roleRes = await auth(http().post('/api/roles')).send({ name: 'Governance Role' });
      const govRoleId = roleRes.body.id as string;
      // Make it a governance role: a global permit grant on an effective-admin action.
      await prisma.grant.create({
        data: {
          organizationId: orgId,
          roleId: govRoleId,
          action: 'role:create',
          effect: 'permit',
          scopeKind: 'global',
        },
      });
      const res = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({
        roleId: govRoleId,
        externalGroupId: 'gov-snowflake-1',
        syncDirection: 'inbound',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('GOVERNANCE_ROLE_NOT_MAPPABLE');
    });

    it('retry clears a broken mapping flag and re-queues sync', async () => {
      const roleRes = await auth(http().post('/api/roles')).send({ name: 'Retry Role' });
      const roleId = roleRes.body.id as string;
      const mapRes = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({ roleId, externalGroupId: 'retry-snowflake-1', syncDirection: 'inbound' });
      const mappingId = mapRes.body.id as string;

      await prisma.externalGroupMapping.update({
        where: { id: mappingId },
        data: { isBroken: true },
      });

      const res = await auth(
        http().post(`/api/integrations/${connectionId}/mappings/${mappingId}/retry`),
      );
      expect(res.status).toBe(200);
      expect(res.body.isBroken).toBe(false);
      const row = await prisma.externalGroupMapping.findUnique({ where: { id: mappingId } });
      expect(row?.isBroken).toBe(false);
    });

    it('re-pointing a mapping clears the broken flag', async () => {
      const roleRes = await auth(http().post('/api/roles')).send({ name: 'Repoint Role' });
      const roleId = roleRes.body.id as string;
      const mapRes = await auth(
        http().post(`/api/integrations/${connectionId}/mappings`),
      ).send({ roleId, externalGroupId: 'old-snowflake', syncDirection: 'inbound' });
      const mappingId = mapRes.body.id as string;
      await prisma.externalGroupMapping.update({
        where: { id: mappingId },
        data: { isBroken: true },
      });
      const res = await auth(
        http().patch(`/api/integrations/${connectionId}/mappings/${mappingId}`),
      ).send({ externalGroupId: 'new-snowflake-99' });
      expect(res.status).toBe(200);
      expect(res.body.externalGroupId).toBe('new-snowflake-99');
      expect(res.body.isBroken).toBe(false);
    });

    it('manual sync logs a reconcile_scheduled activity row', async () => {
      await auth(http().post(`/api/integrations/${connectionId}/sync`));
      const activity = await auth(
        http().get('/api/activity?verbPrefix=integration.reconcile_scheduled'),
      );
      expect(activity.status).toBe(200);
      expect(activity.body.items.length).toBeGreaterThan(0);
      expect(activity.body.items[0].payload.reason).toBe('manual');
    });
  });

  // ---------------------------------------------------------------------------
  // /me identity projection (authMethods, avatar)
  // ---------------------------------------------------------------------------

  describe('/me identity projection', () => {
    it('exposes authMethods + avatarUrl shape', async () => {
      const res = await auth(http().get('/api/me'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.authMethods)).toBe(true);
      expect(res.body.authMethods).toContain('password');
      expect(res.body).toHaveProperty('avatarUrl');
      expect(res.body).toHaveProperty('discordHandle');
    });
  });
});
