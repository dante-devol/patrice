import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  resetDatabase,
} from './helpers';

/** Slice 7.1 — revive endpoints + the grace-window state-machine guard (#28). */
describe('Slice 7.1 — Revive endpoints', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let taskId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Title', required: true, constraints: {} }],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const roleId = adminUser.userRoles[0].roleId;
    for (const action of [
      'task:create',
      'task:retire',
      'task:revive',
      'message:create',
      'message:retire',
      'message:revive',
    ]) {
      const g = await auth(http().post('/api/grants')).send({
        roleId,
        action,
        scopeKind: 'global',
      });
      expect(g.status).toBe(201);
    }

    taskId = (
      await auth(http().post('/api/tasks')).send({ name: 'Chapter', divisionId: writingId })
    ).body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('reviving an active task is rejected (409 NOT_REVIVABLE)', async () => {
    const res = await auth(http().post(`/api/tasks/${taskId}/revive`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_REVIVABLE');
  });

  it('retires then revives a task within the grace window', async () => {
    const retire = await auth(http().post(`/api/tasks/${taskId}/retire`));
    expect(retire.status).toBe(201);
    expect(retire.body.lifecycleState).toBe('retired');

    // While retired, a mutation on the task is hard-denied (403) by Cedar.
    const denied = await auth(http().post(`/api/tasks/${taskId}/retire`));
    expect(denied.status).toBe(403);

    const revive = await auth(http().post(`/api/tasks/${taskId}/revive`));
    expect(revive.status).toBe(200);
    expect(revive.body.lifecycleState).toBe('active');
    expect(revive.body.retiredAt).toBeNull();

    // The revive wrote an audit row.
    const activity = await prisma.activity.findFirst({
      where: { subjectType: 'task', subjectId: taskId, verb: 'task.revived' },
    });
    expect(activity).not.toBeNull();
  });

  it('reviving past the grace window is rejected (409 NOT_REVIVABLE)', async () => {
    await auth(http().post(`/api/tasks/${taskId}/retire`));
    // Backdate the retirement well past the default grace window.
    await prisma.task.update({
      where: { id: taskId },
      data: { retiredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
    });
    const res = await auth(http().post(`/api/tasks/${taskId}/revive`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_REVIVABLE');
    // Restore to active so later state is clean.
    await prisma.task.update({
      where: { id: taskId },
      data: { lifecycleState: 'active', retiredAt: null },
    });
  });

  it('retires then revives a message within the grace window', async () => {
    const msg = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({
      body: 'A comment',
    });
    expect(msg.status).toBe(201);
    const messageId = msg.body.id;

    const retire = await auth(http().post(`/api/messages/${messageId}/retire`));
    expect(retire.status).toBe(200);
    expect(retire.body.lifecycleState).toBe('retired');

    const revive = await auth(http().post(`/api/messages/${messageId}/revive`));
    expect(revive.status).toBe(200);
    expect(revive.body.lifecycleState).toBe('active');
    expect(revive.body.retiredAt).toBeNull();
  });
});
