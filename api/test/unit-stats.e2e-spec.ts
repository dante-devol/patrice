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

/** Division and team stats count only the tasks the caller can see. */
describe('Unit stats', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let draftsTeamId: string;
  let editsTeamId: string;
  let viewer: { userId: string; session: AdminSession };

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin)(r);

  let n = 0;
  const task = async (teamId?: string) => {
    const res = await auth(http().post('/api/tasks')).send({
      name: `T${++n}`,
      divisionId: writingId,
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

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    draftsTeamId = (await auth(http().post('/api/teams')).send({ divisionIds: [writingId], name: 'Drafts' })).body.id;
    editsTeamId = (await auth(http().post('/api/teams')).send({ divisionIds: [writingId], name: 'Edits' })).body.id;
    await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({
      name: 'Default',
      isDefault: true,
      questions: [{ type: 'detail_text', prompt: 'Body', required: true, constraints: {} }],
    });

    // Three Drafts tasks (one completed), two Edits tasks, one division-level task.
    const drafts = [await task(draftsTeamId), await task(draftsTeamId), await task(draftsTeamId)];
    await task(editsTeamId);
    await task(editsTeamId);
    await task();
    const created = await prisma.task.findUniqueOrThrow({ where: { id: drafts[0] } });
    await prisma.task.update({
      where: { id: drafts[0] },
      data: { statusCache: 'approved', completedAt: new Date(created.createdAt.getTime() + 2 * 24 * 3600 * 1000) },
    });

    // The viewer can read units and leads Drafts, so sees only Drafts tasks.
    const reader = await auth(http().post('/api/roles')).send({ name: 'Reader' });
    for (const action of ['division:read', 'team:read']) {
      await auth(http().post('/api/grants')).send({ roleId: reader.body.id, action, scopeKind: 'global' });
    }
    viewer = await inviteAndAccept(booted, admin, { email: 'viewer@example.com', intendedRoleIds: [reader.body.id] });
    const lead = await prisma.role.findFirstOrThrow({ where: { name: 'Project lead' } });
    await auth(http().post(`/api/teams/${draftsTeamId}/role-assignments`)).send({ userId: viewer.userId, roleId: lead.id });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('an admin sees the whole division, with its teams', async () => {
    const res = await auth(http().get(`/api/divisions/${writingId}/stats`));
    expect(res.status).toBe(200);
    expect(res.body.byStatus.open).toBe(5);
    expect(res.body.completed).toBe(1);
    expect(res.body.retired).toBe(0);
    // Weekly points plus one at `to`; the last point is the state now.
    expect(res.body.series).toHaveLength(13);
    expect(res.body.series[12].counts).toEqual({ open: 5, claimed: 0, review: 0, revising: 0, approved: 0, done: 1, retired: 0 });
    expect(res.body.teams).toEqual([
      { teamId: draftsTeamId, name: 'Drafts', open: 2, completed: 1 },
      { teamId: editsTeamId, name: 'Edits', open: 2, completed: 0 },
    ]);
    expect(res.body.openAge.oldestDays).not.toBeNull();
  });

  it('the viewer’s division stats count only the tasks they can see', async () => {
    const res = await as(viewer.session)(http().get(`/api/divisions/${writingId}/stats`));
    expect(res.status).toBe(200);
    expect(res.body.byStatus.open).toBe(2);
    expect(res.body.completed).toBe(1);
    expect(res.body.teams).toEqual([
      { teamId: draftsTeamId, name: 'Drafts', open: 2, completed: 1 },
      { teamId: editsTeamId, name: 'Edits', open: 0, completed: 0 },
    ]);

    const edits = await as(viewer.session)(http().get(`/api/teams/${editsTeamId}/stats`));
    expect(edits.status).toBe(200);
    expect(edits.body.byStatus.open).toBe(0);
    expect(edits.body.teams).toBeUndefined();
  });

  it('a range limits the weekly series and the completion median', async () => {
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const res = await auth(http().get(`/api/teams/${draftsTeamId}/stats`).query({ from, to }));
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(3);
    expect(res.body.medianDaysToComplete).toBe(2);

    const bad = await auth(http().get(`/api/teams/${draftsTeamId}/stats`).query({ from: to, to: from }));
    expect(bad.status).toBe(422);
  });

  it('records each change of a task’s state in its history', async () => {
    const done = await prisma.task.findFirstOrThrow({ where: { completedAt: { not: null } } });
    const history = await prisma.taskStatusHistory.findMany({ where: { taskId: done.id }, orderBy: { changedAt: 'asc' } });
    expect(history.map((h) => h.state)).toEqual(['open', 'done']);

    // Retiring and reviving record too; edits that keep the state don't.
    const other = await prisma.task.findFirstOrThrow({ where: { completedAt: null, teamId: editsTeamId } });
    await auth(http().patch(`/api/tasks/${other.id}`)).send({ name: 'Renamed' });
    await prisma.task.update({ where: { id: other.id }, data: { lifecycleState: 'retired', retiredAt: new Date() } });
    await prisma.task.update({ where: { id: other.id }, data: { lifecycleState: 'active', retiredAt: null } });
    const states = await prisma.taskStatusHistory.findMany({ where: { taskId: other.id }, orderBy: { changedAt: 'asc' } });
    expect(states.map((h) => h.state)).toEqual(['open', 'retired', 'open']);
  });

  it('filters by team, requester and claimant', async () => {
    const edits = await auth(http().get(`/api/divisions/${writingId}/stats`).query({ team: editsTeamId }));
    expect(edits.status).toBe(200);
    expect(edits.body.byStatus.open).toBe(2);
    expect(edits.body.completed).toBe(0);
    expect(edits.body.teams).toEqual([{ teamId: editsTeamId, name: 'Edits', open: 2, completed: 0 }]);

    const both = await auth(http().get(`/api/divisions/${writingId}/stats`).query({ team: `in:${editsTeamId},${draftsTeamId}` }));
    expect(both.body.byStatus.open + both.body.completed).toBe(5);

    const adminId = (await auth(http().get('/api/me'))).body.id;
    const mine = await auth(http().get(`/api/divisions/${writingId}/stats`).query({ requester: adminId }));
    expect(mine.body.byStatus.open).toBe(5);
    const theirs = await auth(http().get(`/api/divisions/${writingId}/stats`).query({ requester: viewer.userId }));
    expect(theirs.body.byStatus.open).toBe(0);
    expect(theirs.body.series[12].counts.open).toBe(0);
    const claimed = await auth(http().get(`/api/divisions/${writingId}/stats`).query({ claimant: adminId }));
    expect(claimed.body.byStatus.open).toBe(0);
  });

  it('needs read access to the unit', async () => {
    const bare = await inviteAndAccept(booted, admin, { email: 'bare@example.com' });
    const res = await as(bare.session)(http().get(`/api/divisions/${writingId}/stats`));
    expect(res.status).toBe(403);
  });
});
