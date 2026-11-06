import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { PUBSUB_PORT, PubSubPort, StreamEvent } from '../src/notifications/pubsub.port';
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
 * The admin workflow: the membership editor's batch save, stale checks on the admin
 * editors' saves, and the "another admin is changing this page" presence events.
 */
describe('Admin workflow', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let adminUserId: string;
  let writingId: string;
  let usaTeamId: string;
  let memberId: string;
  let member: AdminSession;
  let secondAdminId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    adminUserId = (await http().get('/api/me').set('Cookie', admin.cookies)).body.id;
    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    usaTeamId = (await auth(http().post('/api/teams')).send({ name: 'USA', divisionId: writingId })).body.id;
    ({ userId: memberId, session: member } = await inviteAndAccept(booted, admin, { email: 'member@example.com' }));
    const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'Admin' } });
    ({ userId: secondAdminId } = await inviteAndAccept(booted, admin, {
      email: 'second@example.com',
      intendedRoleIds: [adminRole.id],
    }));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test, s: AdminSession = admin) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const membershipsOf = (userId: string) =>
    prisma.membership.findMany({ where: { userId }, select: { divisionId: true, teamId: true } });

  describe('POST /memberships/batch', () => {
    it('adds to a division and a team in one save, with an audit row each', async () => {
      const res = await auth(http().post('/api/memberships/batch')).send({
        changes: [
          { op: 'add', unitType: 'division', unitId: writingId, userId: memberId },
          { op: 'add', unitType: 'team', unitId: usaTeamId, userId: memberId },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: memberId, unitType: 'division', unitId: writingId, source: 'patrice' }),
          expect.objectContaining({ userId: memberId, unitType: 'team', unitId: usaTeamId }),
        ]),
      );
      expect(await membershipsOf(memberId)).toHaveLength(2);
      expect(
        await prisma.activity.count({ where: { verb: 'membership.added', actorUserId: adminUserId } }),
      ).toBe(2);
    });

    it('GET /memberships lists every membership the caller may read', async () => {
      const res = await auth(http().get('/api/memberships'));
      expect(res.status).toBe(200);
      expect(res.body.items.filter((m: { userId: string }) => m.userId === memberId)).toHaveLength(2);
      expect(res.body.units).toEqual(
        expect.arrayContaining([
          { unitType: 'division', unitId: writingId, allowedActions: ['division:manage_members'] },
          { unitType: 'team', unitId: usaTeamId, allowedActions: ['team:manage_members'] },
        ]),
      );
    });

    it('tells a member which units they may change (none)', async () => {
      const res = await auth(http().get('/api/memberships'), member);
      expect(res.status).toBe(200);
      for (const u of res.body.units) expect(u.allowedActions).toEqual([]);
    });

    it('refuses the whole save when one change is stale, and writes nothing', async () => {
      const res = await auth(http().post('/api/memberships/batch')).send({
        changes: [
          { op: 'remove', unitType: 'team', unitId: usaTeamId, userId: memberId },
          // Already a member: someone else added them since the editor loaded.
          { op: 'add', unitType: 'division', unitId: writingId, userId: memberId },
        ],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STALE_MEMBERSHIP');
      expect(await membershipsOf(memberId)).toHaveLength(2);
    });

    it('refuses removing someone who is no longer a member (409)', async () => {
      const res = await auth(http().post('/api/memberships/batch')).send({
        changes: [{ op: 'remove', unitType: 'division', unitId: writingId, userId: secondAdminId }],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('STALE_MEMBERSHIP');
    });

    it('authorizes each unit: a member without manage_members is refused (403)', async () => {
      const res = await auth(http().post('/api/memberships/batch'), member).send({
        changes: [{ op: 'remove', unitType: 'team', unitId: usaTeamId, userId: memberId }],
      });
      expect(res.status).toBe(403);
      expect(await membershipsOf(memberId)).toHaveLength(2);
    });

    it('removes members', async () => {
      const res = await auth(http().post('/api/memberships/batch')).send({
        changes: [
          { op: 'remove', unitType: 'team', unitId: usaTeamId, userId: memberId },
          { op: 'remove', unitType: 'division', unitId: writingId, userId: memberId },
        ],
      });
      expect(res.status).toBe(200);
      expect(await membershipsOf(memberId)).toHaveLength(0);
    });
  });

  describe('stale checks on admin saves', () => {
    it('refuses a team edit made against an old version', async () => {
      const team = await prisma.team.findUniqueOrThrow({ where: { id: usaTeamId } });
      const ok = await auth(http().patch(`/api/teams/${usaTeamId}`)).send({ name: 'USA East', version: team.version });
      expect(ok.status).toBe(200);
      const stale = await auth(http().patch(`/api/teams/${usaTeamId}`)).send({ name: 'USA West', version: team.version });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');
    });

    it('refuses a role rename made against an old version', async () => {
      const role = (await auth(http().post('/api/roles')).send({ name: 'Lead' })).body;
      expect((await auth(http().patch(`/api/roles/${role.id}`)).send({ name: 'Leads', version: role.version })).status).toBe(200);
      const stale = await auth(http().patch(`/api/roles/${role.id}`)).send({ name: 'Leaders', version: role.version });
      expect(stale.status).toBe(409);
    });

    it('refuses a settings change when the value it expected has moved', async () => {
      const ok = await auth(http().patch('/api/config')).send({
        sessionIdleDays: 9,
        expected: { sessionIdleDays: 7 },
      });
      expect(ok.status).toBe(200);
      const stale = await auth(http().patch('/api/config')).send({
        sessionIdleDays: 10,
        expected: { sessionIdleDays: 7 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');
      expect((await auth(http().get('/api/config'))).body.sessionIdleDays).toBe(9);
    });
  });

  describe('POST /admin/presence', () => {
    it('tells the other admins who can see the page, and nobody else', async () => {
      const pubsub = app.get<PubSubPort>(PUBSUB_PORT);
      const seen: Record<string, StreamEvent[]> = { admin: [], second: [], member: [] };
      const unsubscribe = [
        pubsub.subscribe(adminUserId, (e) => seen.admin.push(e)),
        pubsub.subscribe(secondAdminId, (e) => seen.second.push(e)),
        pubsub.subscribe(memberId, (e) => seen.member.push(e)),
      ];
      try {
        const res = await auth(http().post('/api/admin/presence')).send({ page: 'permissions', state: 'editing' });
        expect(res.status).toBe(204);
        expect(seen.second).toEqual([
          expect.objectContaining({ type: 'admin-presence', page: 'permissions', userId: adminUserId, state: 'editing' }),
        ]);
        expect(seen.admin).toEqual([]); // not echoed to the editor
        expect(seen.member).toEqual([]); // can't see the admin area
      } finally {
        unsubscribe.forEach((u) => u());
      }
    });

    it('is refused for someone outside the admin area (403)', async () => {
      const res = await auth(http().post('/api/admin/presence'), member).send({ page: 'users', state: 'editing' });
      expect(res.status).toBe(403);
    });
  });
});
