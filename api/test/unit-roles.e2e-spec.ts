import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AccessService } from '../src/access/access.service';
import { EntityLoader } from '../src/access/entity-loader';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/** Unit roles: roles held at a division or team (ADR 0019). */
describe('Unit roles', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let access: AccessService;

  let projectLeadId: string;
  let writingId: string;
  let artId: string;
  let draftsTeamId: string; // in Writing
  let editsTeamId: string; // in Writing
  let writingTaskId: string;
  let draftsTaskId: string;
  let editsTaskId: string;
  let artTaskId: string;

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin)(r);

  const can = async (userId: string, action: string, taskId: string) =>
    access.decide({ userId, action, resource: await new EntityLoader(prisma).task(taskId) });

  let n = 0;
  let memberRoleId: string;
  const newUser = async () =>
    inviteAndAccept(booted, admin, { email: `u${++n}@example.com`, intendedRoleIds: [memberRoleId] });

  const task = async (divisionId: string, teamId?: string) => {
    const res = await auth(http().post('/api/tasks')).send({
      name: `T${++n}`,
      divisionId,
      ...(teamId ? { teamId } : {}),
      template: { kind: 'default' },
    });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id as string;
  };

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    access = app.get(AccessService);

    memberRoleId = (await prisma.systemSettings.findUniqueOrThrow({ where: { id: 1 } })).memberRoleId!;
    const lead = await prisma.role.findFirstOrThrow({ where: { name: 'Project lead' } });
    projectLeadId = lead.id;
    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    artId = (await auth(http().post('/api/divisions')).send({ name: 'Art' })).body.id;
    draftsTeamId = (await auth(http().post('/api/teams')).send({ divisionId: writingId, name: 'Drafts' })).body.id;
    editsTeamId = (await auth(http().post('/api/teams')).send({ divisionId: writingId, name: 'Edits' })).body.id;
    for (const d of [writingId, artId]) {
      await auth(http().post(`/api/divisions/${d}/request-templates`)).send({
        name: 'Default',
        isDefault: true,
        questions: [{ type: 'detail_text', prompt: 'Body', required: true, constraints: {} }],
      });
    }
    writingTaskId = await task(writingId);
    draftsTaskId = await task(writingId, draftsTeamId);
    editsTaskId = await task(writingId, editsTeamId);
    artTaskId = await task(artId);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('seeds Project lead as an unassigned unit role that leads cannot assign', async () => {
    const roles = await auth(http().get('/api/roles'));
    const lead = roles.body.find((r: { id: string }) => r.id === projectLeadId);
    expect(lead).toMatchObject({ name: 'Project lead', kind: 'unit', assignableByLeads: false });
    expect(await prisma.unitRoleAssignment.count({ where: { roleId: projectLeadId } })).toBe(0);
    const grants = await prisma.grant.findMany({ where: { roleId: projectLeadId } });
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.scopeKind === 'assigned')).toBe(true);
    expect(grants.some((g) => g.action === 'task:bypass_discord_gate')).toBe(false);
  });

  it('a lead at Writing can review Writing tasks but not Art tasks, even as a member of Art', async () => {
    const { userId } = await newUser();
    await auth(http().post(`/api/divisions/${artId}/members`)).send({ userId });
    expect(await can(userId, 'task:review', writingTaskId)).toBe(false);

    const res = await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId,
      roleId: projectLeadId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId, roleId: projectLeadId });

    // Takes effect immediately (the assignment bumped config_version).
    expect(await can(userId, 'task:review', writingTaskId)).toBe(true);
    expect(await can(userId, 'task:review', artTaskId)).toBe(false);
  });

  it('a division assignment covers its teams; a team assignment covers only that team', async () => {
    const division = await newUser();
    await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId: division.userId,
      roleId: projectLeadId,
    });
    expect(await can(division.userId, 'task:update', draftsTaskId)).toBe(true);
    expect(await can(division.userId, 'task:update', editsTaskId)).toBe(true);

    const team = await newUser();
    const res = await auth(http().post(`/api/teams/${draftsTeamId}/role-assignments`)).send({
      userId: team.userId,
      roleId: projectLeadId,
    });
    expect(res.status).toBe(201);
    expect(await can(team.userId, 'task:update', draftsTaskId)).toBe(true);
    expect(await can(team.userId, 'task:update', editsTaskId)).toBe(false);
    expect(await can(team.userId, 'task:update', writingTaskId)).toBe(false);
  });

  it('task lists include the units a user leads', async () => {
    // No Member role, so nothing else makes tasks visible.
    const { userId, session } = await inviteAndAccept(booted, admin, { email: 'bare@example.com' });
    await auth(http().post(`/api/teams/${editsTeamId}/role-assignments`)).send({ userId, roleId: projectLeadId });
    const res = await as(session)(http().get('/api/tasks'));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: { id: string }) => t.id);
    expect(ids).toContain(editsTaskId);
    expect(ids).not.toContain(artTaskId);
  });

  it('assigning adds membership; unassigning keeps it and revokes the authority', async () => {
    const { userId } = await newUser();
    const res = await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId,
      roleId: projectLeadId,
    });
    expect(await prisma.membership.count({ where: { userId, divisionId: writingId } })).toBe(1);
    const verbs = await prisma.activity.findMany({
      where: { subjectId: writingId, verb: { in: ['membership.added', 'unit_role.assigned'] } },
      select: { verb: true, payload: true },
    });
    const mine = verbs.filter((v) => (v.payload as { userId: string }).userId === userId).map((v) => v.verb);
    expect(mine.sort()).toEqual(['membership.added', 'unit_role.assigned']);
    expect(await prisma.notification.count({ where: { recipientUserId: userId, type: 'unit_role.assigned' } })).toBe(1);

    // Idempotent.
    const again = await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId,
      roleId: projectLeadId,
    });
    expect(again.body.id).toBe(res.body.id);

    const list = await auth(http().get(`/api/divisions/${writingId}/role-assignments`));
    expect(list.body.map((a: { id: string }) => a.id)).toContain(res.body.id);
    // The users list carries each user's unit roles (Admin > Users).
    const users = await auth(http().get('/api/users'));
    const row = users.body.find((u: { id: string }) => u.id === userId);
    expect(row.unitRoles).toEqual([{ id: res.body.id, roleId: projectLeadId, unitType: 'division', unitId: writingId }]);

    const del = await auth(http().delete(`/api/divisions/${writingId}/role-assignments/${res.body.id}`));
    expect(del.status).toBe(204);
    expect(await prisma.membership.count({ where: { userId, divisionId: writingId } })).toBe(1);
    expect(await can(userId, 'task:review', writingTaskId)).toBe(false);

    // The assignment belongs to Writing: asking at Art is a 404.
    const other = await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId,
      roleId: projectLeadId,
    });
    const wrong = await auth(http().delete(`/api/divisions/${artId}/role-assignments/${other.body.id}`));
    expect(wrong.status).toBe(404);
  });

  it('a lead can assign a lead-assignable unit role but not Project lead; an admin can assign either', async () => {
    const reviewer = await auth(http().post('/api/roles')).send({ name: 'Reviewer', kind: 'unit', assignableByLeads: true });
    expect(reviewer.status).toBe(201);
    await auth(http().post('/api/grants')).send({ roleId: reviewer.body.id, action: 'task:review', scopeKind: 'assigned' });

    const lead = await newUser();
    await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId: lead.userId,
      roleId: projectLeadId,
    });
    const target = await newUser();

    const pickable = await as(lead.session)(http().get(`/api/divisions/${writingId}/assignable-roles`));
    expect(pickable.status).toBe(200);
    expect(pickable.body.map((r: { id: string }) => r.id)).toEqual([reviewer.body.id]);
    const adminPickable = await auth(http().get(`/api/divisions/${writingId}/assignable-roles`));
    expect(adminPickable.body.map((r: { id: string }) => r.id).sort()).toEqual([projectLeadId, reviewer.body.id].sort());

    const ok = await as(lead.session)(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId: target.userId,
      roleId: reviewer.body.id,
    });
    expect(ok.status).toBe(201);
    // A team of the division the lead leads.
    const okTeam = await as(lead.session)(http().post(`/api/teams/${draftsTeamId}/role-assignments`)).send({
      userId: target.userId,
      roleId: reviewer.body.id,
    });
    expect(okTeam.status).toBe(201);

    const no = await as(lead.session)(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId: target.userId,
      roleId: projectLeadId,
    });
    expect(no.status).toBe(403);
    // Nor anything at a division the lead doesn't lead.
    const elsewhere = await as(lead.session)(http().post(`/api/divisions/${artId}/role-assignments`)).send({
      userId: target.userId,
      roleId: reviewer.body.id,
    });
    expect(elsewhere.status).toBe(403);
  });

  it('a forbid on a unit role applies where it is assigned', async () => {
    const limited = await auth(http().post('/api/roles')).send({ name: 'No retire', kind: 'unit' });
    await auth(http().post('/api/grants')).send({
      roleId: limited.body.id,
      action: 'task:retire',
      scopeKind: 'assigned',
      effect: 'forbid',
    });
    const { userId } = await newUser();
    await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({ userId, roleId: projectLeadId });
    expect(await can(userId, 'task:retire', writingTaskId)).toBe(true);
    await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({ userId, roleId: limited.body.id });
    expect(await can(userId, 'task:retire', writingTaskId)).toBe(false);
    expect(await can(userId, 'task:review', writingTaskId)).toBe(true);
  });

  it('a unit role refuses Organization actions and non-assigned scopes; an org role refuses assigned', async () => {
    const orgAction = await auth(http().post('/api/grants')).send({
      roleId: projectLeadId,
      action: 'user:grant_role',
      scopeKind: 'assigned',
    });
    expect(orgAction.status).toBe(422);
    expect(orgAction.body.error.code).toBe('UNIT_ROLE_SCOPE');

    const globalScope = await auth(http().post('/api/grants')).send({
      roleId: projectLeadId,
      action: 'task:read',
      scopeKind: 'global',
    });
    expect(globalScope.status).toBe(422);
    expect(globalScope.body.error.code).toBe('UNIT_ROLE_SCOPE');

    const orgRole = await auth(http().post('/api/roles')).send({ name: 'Plain' });
    const assigned = await auth(http().post('/api/grants')).send({
      roleId: orgRole.body.id,
      action: 'task:read',
      scopeKind: 'assigned',
    });
    expect(assigned.status).toBe(422);
    expect(assigned.body.error.code).toBe('UNIT_ROLE_SCOPE');

    // An org role can't be assigned at a unit, and a unit role can't be granted org-wide.
    const { userId } = await newUser();
    const wrongKind = await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
      userId,
      roleId: orgRole.body.id,
    });
    expect(wrongKind.status).toBe(422);
    expect(wrongKind.body.error.code).toBe('NOT_A_UNIT_ROLE');
    const orgWide = await auth(http().post(`/api/users/${userId}/roles`)).send({ roleId: projectLeadId });
    expect(orgWide.status).toBe(422);
    expect(orgWide.body.error.code).toBe('UNIT_ROLE_NOT_GRANTABLE');
  });

  it('the admin floor is untouched: leads hold no governance, and the last admin stays protected', async () => {
    const { userId } = await newUser();
    await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({ userId, roleId: projectLeadId });
    const decision = await access.decide({
      userId,
      action: 'role:create',
      resource: { type: 'Organization', id: 'patrice' },
    });
    expect(decision).toBe(false);

    const adminRole = await prisma.role.findFirstOrThrow({ where: { name: 'Admin' } });
    const me = await auth(http().get('/api/me'));
    const revoke = await auth(http().delete(`/api/users/${me.body.id}/roles/${adminRole.id}`));
    expect(revoke.status).toBe(409);
    expect(revoke.body.error.code).toBe('LAST_ADMIN');
  });

  it('/me/units lists the units a user belongs to or leads', async () => {
    const { userId, session } = await newUser();
    await auth(http().post(`/api/divisions/${artId}/members`)).send({ userId });
    await auth(http().post(`/api/teams/${draftsTeamId}/role-assignments`)).send({ userId, roleId: projectLeadId });
    const res = await as(session)(http().get('/api/me/units'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { unitType: 'division', unitId: artId, name: 'Art', divisionId: null, member: true, roles: [] },
      { unitType: 'team', unitId: draftsTeamId, name: 'Drafts', divisionId: writingId, member: true, roles: [{ id: projectLeadId, name: 'Project lead' }] },
    ]);
  });
});
