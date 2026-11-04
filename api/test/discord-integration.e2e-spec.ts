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
import { FakeSyncPort } from './fake-sync-port';

/**
 * Phase 6 done-criteria, against an in-memory guild: sync links appear without anyone
 * clicking, mappings can grant memberships, a push followed by a revoke stays revoked
 * (D9), removed mappings and connections leave what they granted as the admin chose
 * (D23), and the bot token never sits in plaintext.
 */
describe('Discord integration', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let discord: FakeSyncPort;
  let connectionId: string;
  let member: { userId: string; session: AdminSession };

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const sync = () => auth(http().post(`/api/integrations/${connectionId}/sync`));
  const role = async (name: string) => (await auth(http().post('/api/roles')).send({ name })).body.id as string;
  const holds = (userId: string, roleId: string) => prisma.userRole.findUnique({ where: { userId_roleId: { userId, roleId } } });
  const map = async (body: Record<string, unknown>) => {
    const res = await auth(http().post(`/api/integrations/${connectionId}/mappings`)).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    discord = booted.discord;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    member = await inviteAndAccept(booted, admin, { email: 'gamer@example.com' });
    // The member signed in with Discord once, so Patrice knows their Discord id.
    await prisma.userIdentity.create({ data: { userId: member.userId, provider: 'discord', providerSubject: 'd-1' } });
    discord.member('d-1');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('connecting a server links every member whose Discord id is known (D22)', async () => {
    const res = await auth(http().post('/api/integrations')).send({
      provider: 'discord',
      externalWorkspaceId: 'guild-1',
      displayName: 'Guild',
      botToken: 'Bot.very.secret',
    });
    expect(res.status).toBe(201);
    connectionId = res.body.id;
    const link = await prisma.externalIdentity.findUnique({
      where: { userId_connectionId: { userId: member.userId, connectionId } },
    });
    expect(link?.externalUserId).toBe('d-1');
  });

  it('the bot token is encrypted by the worker and the job that carried it is wiped (D13)', async () => {
    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.credentialsRef).toMatch(/^aead:/);
    expect(JSON.stringify(row.config)).not.toContain('secret');
    const jobs = await prisma.$queryRawUnsafe<{ data: unknown }[]>(
      `SELECT data FROM pgboss.job WHERE name = 'integration.store-token'`,
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(JSON.stringify(j.data)).not.toContain('secret');
  });

  it('an inbound mapping grants a role, and a membership mapping grants a division', async () => {
    const reviewer = await role('Reviewer');
    const division = (await auth(http().post('/api/divisions')).send({ name: 'Guild members' })).body.id;
    await map({ roleId: reviewer, externalGroupId: 'g-reviewer', syncDirection: 'inbound' });
    await map({ divisionId: division, externalGroupId: 'g-member', syncDirection: 'inbound' });
    discord.member('d-1', 'g-reviewer', 'g-member');

    expect((await sync()).status).toBe(202);
    expect((await holds(member.userId, reviewer))?.source).toBe('integration');
    const membership = await prisma.membership.findFirst({ where: { userId: member.userId, divisionId: division } });
    expect(membership?.source).toBe('integration');
  });

  it('a pushed grant that Patrice then revokes stays revoked (D9)', async () => {
    const lead = await role('Lead');
    await map({ roleId: lead, externalGroupId: 'g-lead', syncDirection: 'bidirectional' });
    discord.groups.add('g-lead');
    await sync();

    // Granted in Patrice and pushed to Discord.
    await auth(http().post(`/api/users/${member.userId}/roles`)).send({ roleId: lead });
    await sync();
    expect(discord.has('d-1', 'g-lead')).toBe(true);

    // Revoked in Patrice while nothing else syncs (the Gateway being down), then a sync.
    await auth(http().delete(`/api/users/${member.userId}/roles/${lead}`));
    await sync();
    expect(await holds(member.userId, lead)).toBeNull();
    expect(discord.has('d-1', 'g-lead')).toBe(false);
  });

  it('a governance permit cannot go to a role an integration grants (D4)', async () => {
    const reviewer = (await prisma.role.findFirstOrThrow({ where: { name: 'Reviewer' } })).id;
    const res = await auth(http().post('/api/grants')).send({ roleId: reviewer, action: 'grant:create', scopeKind: 'global' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GOVERNANCE_ROLE_MAPPED');
  });

  describe('deleting a mapping (D23)', () => {
    it('shows how much it granted, and keeps those grants as native by default', async () => {
      const keeper = await role('Keeper');
      const id = await map({ roleId: keeper, externalGroupId: 'g-keeper', syncDirection: 'inbound' });
      discord.member('d-1', ...discord.members.get('d-1')!, 'g-keeper');
      await sync();
      const list = (await auth(http().get(`/api/integrations/${connectionId}/mappings`))).body;
      expect(list.find((m: { id: string }) => m.id === id).grantedCount).toBe(1);

      expect((await auth(http().delete(`/api/integrations/${connectionId}/mappings/${id}`))).status).toBe(204);
      expect((await holds(member.userId, keeper))?.source).toBe('patrice');
      const audit = await prisma.activity.findFirstOrThrow({ where: { verb: 'external_group_mapping.deleted', subjectId: id } });
      expect(audit.payload).toMatchObject({ grants: 'keep', affected: 1 });
    });

    it('or revokes them when the admin says so', async () => {
      const temp = await role('Temp');
      const id = await map({ roleId: temp, externalGroupId: 'g-temp', syncDirection: 'inbound' });
      discord.member('d-1', ...discord.members.get('d-1')!, 'g-temp');
      await sync();
      expect(await holds(member.userId, temp)).not.toBeNull();
      await auth(http().delete(`/api/integrations/${connectionId}/mappings/${id}?grants=revoke`));
      expect(await holds(member.userId, temp)).toBeNull();
    });
  });

  it('a failed sync never leaves the connection stuck running (D26)', async () => {
    discord.down = true;
    try {
      await sync();
      const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(row.syncState).toBe('idle');
      expect(row.lastError).toMatch(/unreachable/);
    } finally {
      discord.down = false;
    }
  });

  it('nextReconcileAt comes from the API, an hour after the last sync', async () => {
    const conn = (await auth(http().get('/api/integrations'))).body.find((c: { id: string }) => c.id === connectionId);
    expect(new Date(conn.nextReconcileAt).getTime() - new Date(conn.lastSyncAt).getTime()).toBe(60 * 60 * 1000);
  });

  describe('retiring and collecting the connection', () => {
    it('applies the chosen disposition to what it granted when collected', async () => {
      const reviewer = (await prisma.role.findFirstOrThrow({ where: { name: 'Reviewer' } })).id;
      const res = await auth(http().post(`/api/integrations/${connectionId}/retire`)).send({ grants: 'revoke' });
      expect(res.body.retireDisposition).toBe('revoke');
      // Nothing changes during grace.
      expect(await holds(member.userId, reviewer)).not.toBeNull();

      await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
      const sweep = await auth(http().post('/api/gc/sweep'));
      expect(sweep.body.integrationConnections).toContain(connectionId);
      expect(await holds(member.userId, reviewer)).toBeNull();
      expect(await prisma.membership.count({ where: { userId: member.userId, source: 'integration' } })).toBe(0);
      await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    });

    it('reconnecting a retired server revives its connection (D27)', async () => {
      const first = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'guild-2',
        displayName: 'Second',
        botToken: 'Bot.two',
      });
      await auth(http().post(`/api/integrations/${first.body.id}/retire`));
      const again = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'guild-2',
        displayName: 'Second, again',
        botToken: 'Bot.three',
      });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      expect(again.body).toMatchObject({ lifecycleState: 'active', displayName: 'Second, again', retireDisposition: null });
    });
  });
});
