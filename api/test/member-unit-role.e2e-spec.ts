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
 * ADR 0022: Everyone is held by every user and can never be given, taken away, mapped,
 * renamed, retired or targeted; Member is a unit role that divisions and teams give
 * as their default when people join; leaving takes back only what joining gave.
 */
describe('Everyone, Member and default unit roles', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let everyoneId: string;
  let memberId: string;
  let writingId: string;
  let taskId: string;

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession, r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin, r);
  let n = 0;
  const newUser = () => inviteAndAccept(booted, admin, { email: `mur${++n}@example.com`, intendedRoleIds: [] });
  const held = (userId: string, roleId: string) =>
    prisma.unitRoleAssignment.findMany({ where: { userId, roleId, divisionId: writingId } });

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    everyoneId = (await prisma.role.findFirstOrThrow({ where: { kind: 'baseline' } })).id;
    memberId = (await prisma.systemSettings.findFirstOrThrow()).defaultUnitRoleId!;
    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({
      name: 'Default',
      isDefault: true,
      questions: [{ type: 'text', prompt: 'Q', required: false, constraints: {} }],
    });
    taskId = (await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId, template: { kind: 'default' } }))
      .body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  describe('Everyone', () => {
    it('is held by someone with no role: they see people and divisions, not the unit’s tasks', async () => {
      const u = await newUser();
      expect((await http().get('/api/users').set('Cookie', u.session.cookies)).status).toBe(200);
      expect((await http().get('/api/divisions').set('Cookie', u.session.cookies)).body).toHaveLength(1);
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', u.session.cookies)).status).toBe(403);
    });

    it('is never given, taken away, pre-assigned, renamed, retired or targeted', async () => {
      const u = await newUser();
      expect((await auth(http().post(`/api/users/${u.userId}/roles`)).send({ roleId: everyoneId })).body.error.code).toBe(
        'BASELINE_ROLE',
      );
      expect((await auth(http().delete(`/api/users/${u.userId}/roles/${everyoneId}`))).status).toBe(409);
      expect((await auth(http().post('/api/invitations')).send({ intendedRoleIds: [everyoneId] })).status).toBe(409);
      expect((await auth(http().patch(`/api/roles/${everyoneId}`)).send({ name: 'All' })).status).toBe(409);
      expect((await auth(http().post(`/api/roles/${everyoneId}/retire`))).status).toBe(409);
      const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'Admin' } });
      const targeted = await auth(http().post('/api/grants')).send({
        roleId: adminRole.id,
        action: 'user:grant_role',
        scopeKind: 'role',
        scopeRoleId: everyoneId,
      });
      expect(targeted.status).toBe(409);
    });

    it('is editable: a grant on Everyone applies to every user', async () => {
      const u = await newUser();
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', u.session.cookies)).status).toBe(403);
      const g = await auth(http().post('/api/grants')).send({ roleId: everyoneId, action: 'task:read', scopeKind: 'global' });
      expect(g.status).toBe(201);
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', u.session.cookies)).status).toBe(200);
      await auth(http().delete(`/api/grants/${g.body.id}`));
    });
  });

  describe('default roles', () => {
    it('new divisions and teams start with the org default; it must be an active unit role', async () => {
      const d = await auth(http().post('/api/divisions')).send({ name: 'Art' });
      expect(d.body.defaultRoleId).toBe(memberId);
      const t = await auth(http().post('/api/teams')).send({ name: 'USA', divisionIds: [writingId] });
      expect(t.body.defaultRoleId).toBe(memberId);
      const none = await auth(http().post('/api/divisions')).send({ name: 'Quiet', defaultRoleId: null });
      expect(none.body.defaultRoleId).toBeNull();
      const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'Admin' } });
      const bad = await auth(http().patch(`/api/divisions/${writingId}`)).send({ defaultRoleId: adminRole.id });
      expect(bad.body.error.code).toBe('NOT_A_DEFAULT_ROLE');
    });

    it('joining gives Member, which lets the person work; leaving takes it back', async () => {
      const u = await newUser();
      await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: u.userId });
      expect(await held(u.userId, memberId)).toEqual([expect.objectContaining({ viaDefault: true })]);
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', u.session.cookies)).status).toBe(200);
      expect((await as(u.session, http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);
      await auth(http().delete(`/api/divisions/${writingId}/members/${u.userId}`));
      expect(await held(u.userId, memberId)).toEqual([]);
      // Still seated: they can see the task and give up the seat (Everyone).
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', u.session.cookies)).status).toBe(200);
      expect((await as(u.session, http().post(`/api/tasks/${taskId}/leave`))).status).toBe(200);
    });

    it('leaving keeps a role the person was appointed to, even when it is the default', async () => {
      const u = await newUser();
      await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({ userId: u.userId, roleId: memberId });
      expect(await held(u.userId, memberId)).toEqual([expect.objectContaining({ viaDefault: false })]);
      await auth(http().delete(`/api/divisions/${writingId}/members/${u.userId}`));
      expect(await held(u.userId, memberId)).toHaveLength(1);
    });

    it('a changed default applies to new joins; current members get it only when asked', async () => {
      const reviewer = await auth(http().post('/api/roles')).send({ name: 'Reviewer', kind: 'unit' });
      const before = await newUser();
      await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: before.userId });
      await auth(http().patch(`/api/divisions/${writingId}`)).send({ defaultRoleId: reviewer.body.id });
      const after = await newUser();
      await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: after.userId });
      expect(await held(after.userId, reviewer.body.id)).toHaveLength(1);
      expect(await held(before.userId, reviewer.body.id)).toHaveLength(0);

      const given = await auth(http().post(`/api/divisions/${writingId}/members/default-role`));
      expect(given.status).toBe(200);
      expect(given.body.given).toBeGreaterThanOrEqual(1);
      expect(await held(before.userId, reviewer.body.id)).toEqual([expect.objectContaining({ viaDefault: true })]);
      await auth(http().patch(`/api/divisions/${writingId}`)).send({ defaultRoleId: memberId });
    });

    it('the org default for new units is a setting', async () => {
      const reviewer = (await prisma.role.findFirstOrThrow({ where: { name: 'Reviewer' } })).id;
      const s = await auth(http().patch('/api/config')).send({ defaultUnitRoleId: reviewer });
      expect(s.body.defaultUnitRoleId).toBe(reviewer);
      expect((await auth(http().post('/api/divisions')).send({ name: 'Later' })).body.defaultRoleId).toBe(reviewer);
      await auth(http().patch('/api/config')).send({ defaultUnitRoleId: memberId });
    });
  });

  it("a unit role's own grant is accepted, and limited to the unit", async () => {
    const g = await auth(http().post('/api/grants')).send({ roleId: memberId, action: 'message:update', scopeKind: 'own' });
    expect([200, 201, 409]).toContain(g.status); // already seeded on Member
    const reviewer = (await prisma.role.findFirstOrThrow({ where: { name: 'Reviewer' } })).id;
    const ok = await auth(http().post('/api/grants')).send({ roleId: reviewer, action: 'message:update', scopeKind: 'own' });
    expect(ok.status).toBe(201);
    const bad = await auth(http().post('/api/grants')).send({ roleId: reviewer, action: 'task:read', scopeKind: 'global' });
    expect(bad.body.error.code).toBe('UNIT_ROLE_SCOPE');
  });
});
