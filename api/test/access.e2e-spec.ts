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
 * Phase 2 done-criteria: membership apart from authority, reads under Cedar, the
 * admin floor as a real invariant, the seeded roles, and requireDiscordLink enforced
 * by the API.
 */
describe('Access: membership, visibility, floor, seeded roles, Discord gate', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let memberRoleId: string;
  let adminUserId: string;
  let openId: string;
  let secretId: string;
  let member: { userId: string; session: AdminSession };
  let outsider: { userId: string; session: AdminSession };

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession, r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin, r);

  async function makeTask(divisionId: string, name = 'T'): Promise<string> {
    const res = await auth(http().post('/api/tasks')).send({ name, divisionId, template: { kind: 'default' } });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    memberRoleId = (await prisma.systemSettings.findFirstOrThrow()).memberRoleId!;
    adminUserId = (await http().get('/api/me').set('Cookie', admin.cookies)).body.id;

    openId = (await auth(http().post('/api/divisions')).send({ name: 'Open' })).body.id;
    secretId = (await auth(http().post('/api/divisions')).send({ name: 'Secret', restrictClaims: true })).body.id;
    for (const d of [openId, secretId]) {
      await auth(http().post(`/api/divisions/${d}/request-templates`)).send({ name: 'Default', isDefault: true,
        questions: [{ type: 'text', prompt: 'Q', required: true, constraints: {} }],
      });
    }
    member = await inviteAndAccept(booted, admin, { email: 'member@example.com', intendedRoleIds: [memberRoleId] });
    outsider = await inviteAndAccept(booted, admin, { email: 'outsider@example.com', intendedRoleIds: [memberRoleId] });
    await auth(http().post(`/api/divisions/${openId}/members`)).send({ userId: member.userId });
    await auth(http().post(`/api/divisions/${secretId}/members`)).send({ userId: member.userId });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  describe('a fresh install can do work', () => {
    it('new invitations pre-assign Member by default', async () => {
      const inv = await auth(http().post('/api/invitations')).send({});
      const roles = await prisma.invitationRole.findMany({ where: { invitationId: inv.body.id } });
      expect(roles.map((r) => r.roleId)).toEqual([memberRoleId]);
    });

    it('Admin creates a task with no extra grants; a Member claims and submits it', async () => {
      const taskId = await makeTask(openId, 'Fresh');
      const claim = await as(member.session, http().post(`/api/tasks/${taskId}/claim`));
      expect(claim.status).toBe(200);
      const tpl = await http().get(`/api/tasks/${taskId}/request-template`).set('Cookie', member.session.cookies);
      expect(tpl.status).toBe(200);
      const submit = await as(member.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [{ questionId: tpl.body.questions[0].id, value: 'done' }],
      });
      expect(submit.status).toBe(201);
    });

    it('a Member can request work in a division they belong to, and only there', async () => {
      const ok = await as(member.session, http().post('/api/tasks')).send({ name: 'Mine', divisionId: openId, template: { kind: 'default' } });
      expect(ok.status).toBe(201);
      const no = await as(outsider.session, http().post('/api/tasks')).send({ name: 'Not mine', divisionId: openId, template: { kind: 'default' } });
      expect(no.status).toBe(403);
    });
  });

  describe('reads are decided by Cedar', () => {
    it('a Member sees names, but not other users’ email addresses', async () => {
      const res = await http().get('/api/users').set('Cookie', member.session.cookies);
      expect(res.status).toBe(200);
      const adminRow = res.body.find((u: { id: string }) => u.id === adminUserId);
      expect(adminRow.displayName).toBe('Admin');
      expect(adminRow.email).toBeNull();
      const self = res.body.find((u: { id: string }) => u.id === member.userId);
      expect(self.email).toBe('member@example.com');
    });

    it("a restricted division's tasks are invisible to non-members", async () => {
      const secretTask = await makeTask(secretId, 'Hidden');
      const openTask = await makeTask(openId, 'Visible');

      const outsiderList = await http().get('/api/tasks').set('Cookie', outsider.session.cookies);
      const outsiderIds = outsiderList.body.items.map((t: { id: string }) => t.id);
      expect(outsiderIds).toContain(openTask);
      expect(outsiderIds).not.toContain(secretTask);
      expect((await http().get(`/api/tasks/${secretTask}`).set('Cookie', outsider.session.cookies)).status).toBe(403);
      expect(
        (await http().get(`/api/tasks/${secretTask}/messages`).set('Cookie', outsider.session.cookies)).status,
      ).toBe(403);

      const memberList = await http().get('/api/tasks').set('Cookie', member.session.cookies);
      expect(memberList.body.items.map((t: { id: string }) => t.id)).toContain(secretTask);
    });

    it('each task carries what the caller may do with it', async () => {
      const taskId = await makeTask(openId, 'Rights');
      const asMember = await http().get(`/api/tasks/${taskId}`).set('Cookie', member.session.cookies);
      expect(asMember.body.allowedActions).toEqual(expect.arrayContaining(['task:assign', 'message:create']));
      expect(asMember.body.allowedActions).not.toContain('task:retire');
      const asAdmin = await http().get(`/api/tasks/${taskId}`).set('Cookie', admin.cookies);
      expect(asAdmin.body.allowedActions).toContain('task:retire');
    });
  });

  describe('leaving depends on holding the seat, not on eligibility', () => {
    it('a claimant who loses membership of a restricted division can still leave', async () => {
      const taskId = await makeTask(secretId, 'Leave me');
      expect((await as(member.session, http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);
      await auth(http().delete(`/api/divisions/${secretId}/members/${member.userId}`));
      const left = await as(member.session, http().post(`/api/tasks/${taskId}/leave`));
      expect(left.status).toBe(200);
      await auth(http().post(`/api/divisions/${secretId}/members`)).send({ userId: member.userId });
    });
  });

  describe('the admin floor is a real Cedar invariant', () => {
    it('a forbid grant that would lock out every admin is refused (D20)', async () => {
      const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'Admin' } });
      const res = await auth(http().post('/api/grants')).send({
        roleId: adminRole.id,
        action: 'grant:create',
        effect: 'forbid',
        scopeKind: 'global',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    });

    it('granting the only admin a role that carries a governance forbid is refused', async () => {
      const blocker = (await auth(http().post('/api/roles')).send({ name: 'Blocker' })).body.id;
      // The role isn't held by anyone yet, so the forbid itself is allowed…
      const g = await auth(http().post('/api/grants')).send({
        roleId: blocker,
        action: 'role:update',
        effect: 'forbid',
        scopeKind: 'global',
      });
      expect(g.status).toBe(201);
      // …but handing it to the last admin isn't.
      const res = await auth(http().post(`/api/users/${adminUserId}/roles`)).send({ roleId: blocker });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    });

    it('retiring a division no longer touches authority (D2 is structurally gone)', async () => {
      const div = (await auth(http().post('/api/divisions')).send({ name: 'Short-lived' })).body.id;
      const res = await auth(http().post(`/api/divisions/${div}/retire`));
      expect(res.status).toBe(201);
      expect((await http().get('/api/me').set('Cookie', admin.cookies)).body.allowedActions).toContain('grant:create');
    });
  });

  describe('requireDiscordLink is enforced by the API (D14)', () => {
    let taskId: string;

    beforeAll(async () => {
      taskId = await makeTask(openId, 'Gated');
      await prisma.integrationConnection.create({
        data: { provider: 'discord', externalWorkspaceId: 'gate-guild', displayName: 'Gate' },
      });
      await auth(http().patch('/api/config')).send({ requireDiscordLink: true });
    });

    afterAll(async () => {
      await auth(http().patch('/api/config')).send({ requireDiscordLink: false });
    });

    it('an unlinked member loses task access, and /me says why', async () => {
      const me = await http().get('/api/me').set('Cookie', member.session.cookies);
      expect(me.body.taskAccessBlockedByDiscord).toBe(true);
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', member.session.cookies)).status).toBe(403);
      const list = await http().get('/api/tasks').set('Cookie', member.session.cookies);
      expect(list.body.items).toEqual([]);
      // Account and admin surfaces stay reachable.
      expect((await http().get('/api/me/sessions').set('Cookie', member.session.cookies)).status).toBe(200);
    });

    it('a task:bypass_discord_gate grant exempts a role', async () => {
      const exempt = (await auth(http().post('/api/roles')).send({ name: 'Contractor' })).body.id;
      await auth(http().post('/api/grants')).send({
        roleId: exempt,
        action: 'task:bypass_discord_gate',
        scopeKind: 'global',
      });
      await auth(http().post(`/api/users/${member.userId}/roles`)).send({ roleId: exempt });
      const me = await http().get('/api/me').set('Cookie', member.session.cookies);
      expect(me.body.taskAccessBlockedByDiscord).toBe(false);
      expect((await http().get(`/api/tasks/${taskId}`).set('Cookie', member.session.cookies)).status).toBe(200);
    });
  });
});
