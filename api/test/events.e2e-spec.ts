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
 * Phase 3: retired tasks stay readable, GC handles Discord-linked users, and loose
 * references are now foreign keys.
 */
describe('Lifecycle, events and GC', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let divisionId: string;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    divisionId = (await auth(http().post('/api/divisions')).send({ name: 'Work' })).body.id;
    await auth(http().post(`/api/divisions/${divisionId}/request-templates`)).send({ name: 'Default', isDefault: true, questions: [] });
    // Collect anything retired immediately.
    await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it("a retired task's thread and timeline stay readable during grace (D15)", async () => {
    await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    const taskId = (await auth(http().post('/api/tasks')).send({ name: 'Old', divisionId, template: { kind: 'default' } })).body.id;
    await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'context' });
    await auth(http().post(`/api/tasks/${taskId}/retire`));

    const thread = await auth(http().get(`/api/tasks/${taskId}/messages`));
    expect(thread.status).toBe(200);
    expect(thread.body.items).toHaveLength(1);
    const timeline = await auth(http().get(`/api/tasks/${taskId}/timeline`));
    expect(timeline.body.map((e: { type: string }) => e.type)).toEqual(['task.created', 'task.retired']);
    // Posting is still refused.
    expect((await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'late' })).status).toBe(409);
    await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
  });

  it('GC collects a Discord-linked user with no history (D10)', async () => {
    const { userId } = await inviteAndAccept(booted, admin, { email: 'linked@example.com', intendedRoleIds: [] });
    const conn = await prisma.integrationConnection.create({
      data: { provider: 'discord', externalWorkspaceId: 'gc-guild', displayName: 'GC' },
    });
    await prisma.externalIdentity.create({
      data: { userId, connectionId: conn.id, externalUserId: '42', externalHandle: 'handle' },
    });
    await auth(http().post(`/api/users/${userId}/retire`));
    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.usersDeleted).toContain(userId);
    expect(await prisma.appUser.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('a history-bearing scrub removes the Discord id and handle (D10)', async () => {
    const { userId } = await inviteAndAccept(booted, admin, { email: 'hist-linked@example.com', intendedRoleIds: [] });
    const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { externalWorkspaceId: 'gc-guild' } });
    await prisma.externalIdentity.create({
      data: { userId, connectionId: conn.id, externalUserId: '43', externalHandle: 'secret-handle' },
    });
    const taskId = (await auth(http().post('/api/tasks')).send({ name: 'Theirs', divisionId, template: { kind: 'default' } })).body.id;
    await prisma.message.create({ data: { taskId, senderUserId: userId, body: 'authored' } });
    await auth(http().post(`/api/users/${userId}/retire`));
    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.usersScrubbed).toContain(userId);
    expect(await prisma.externalIdentity.count({ where: { userId } })).toBe(0);
    expect((await prisma.appUser.findUniqueOrThrow({ where: { id: userId } })).email).toBeNull();
  });

  it('grants scoped to a division go when the division is collected', async () => {
    const div = (await auth(http().post('/api/divisions')).send({ name: 'Short' })).body.id;
    const role = (await auth(http().post('/api/roles')).send({ name: 'Scoped' })).body.id;
    const grant = await auth(http().post('/api/grants')).send({
      roleId: role,
      action: 'task:read',
      scopeKind: 'specific_division',
      scopeDivisionId: div,
    });
    expect(grant.status).toBe(201);
    await auth(http().post(`/api/divisions/${div}/retire`));
    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.divisions).toContain(div);
    expect(await prisma.grant.findUnique({ where: { id: grant.body.id } })).toBeNull();
  });
});
