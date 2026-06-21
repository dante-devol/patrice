/* eslint-disable */
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

/** Slice 7.3 — GC sweep: aggregate deletion, RESTRICT deferral, orphaned blobs (#30). */
describe('Slice 7.3 — GC sweep', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let writingId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const roleId = adminUser.userRoles[0].roleId;
    for (const action of [
      'task:create',
      'task:retire',
      'task:assign',
      'message:create',
      'attachment:create',
    ]) {
      await auth(http().post('/api/grants')).send({ roleId, action, scopeKind: 'global' });
    }

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Title', required: true, constraints: {} }],
    });
    // A zero-length grace window makes anything retired immediately collectable.
    await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('deletes a retired task aggregate as a unit; activity audit survives', async () => {
    const taskId = (
      await auth(http().post('/api/tasks')).send({ name: 'Doomed', divisionId: writingId })
    ).body.id;
    await auth(http().post(`/api/tasks/${taskId}/claim`));
    const messageId = (
      await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'hi' })
    ).body.id;
    const up = await auth(http().post(`/api/messages/${messageId}/attachments`)).attach(
      'file',
      Buffer.from('blob bytes'),
      { filename: 'a.txt', contentType: 'text/plain' },
    );
    expect(up.status).toBe(201);

    await auth(http().post(`/api/tasks/${taskId}/retire`));

    const dry = await auth(http().post('/api/gc/sweep/dry-run'));
    expect(dry.status).toBe(200);
    expect(dry.body.tasks).toContain(taskId);

    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.status).toBe(200);
    expect(sweep.body.tasks).toContain(taskId);

    // The whole aggregate is gone.
    expect(await prisma.task.findUnique({ where: { id: taskId } })).toBeNull();
    expect(await prisma.message.count({ where: { taskId } })).toBe(0);
    expect(await prisma.taskClaimant.count({ where: { taskId } })).toBe(0);
    expect(await prisma.attachment.count({ where: { messageId } })).toBe(0);
    expect(await prisma.questionnaire.count({ where: { ownerTaskId: taskId } })).toBe(0);

    // The append-only activity log survives the aggregate it describes.
    expect(
      await prisma.activity.count({ where: { subjectId: taskId, verb: 'task.retired' } }),
    ).toBe(1);
    expect(
      await prisma.activity.count({ where: { subjectId: taskId, verb: 'gc.task_collected' } }),
    ).toBe(1);
  });

  it('a division referenced by an active task survives; collects once dereferenced', async () => {
    const divId = (await auth(http().post('/api/divisions')).send({ name: 'Referenced' })).body.id;
    await auth(http().put(`/api/divisions/${divId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Q', required: false, constraints: {} }],
    });
    const taskId = (
      await auth(http().post('/api/tasks')).send({ name: 'Live', divisionId: divId })
    ).body.id;
    const inherentRole = await prisma.role.findFirstOrThrow({ where: { divisionId: divId } });

    await auth(http().post(`/api/divisions/${divId}/retire`));

    // RESTRICT deferral: the live task keeps the division out of this sweep.
    const sweep1 = await auth(http().post('/api/gc/sweep'));
    expect(sweep1.body.divisions).not.toContain(divId);
    expect(await prisma.division.findUnique({ where: { id: divId } })).not.toBeNull();

    // Dereference it (retire + GC the task), then the next sweep collects the division
    // and its inherent role together.
    await auth(http().post(`/api/tasks/${taskId}/retire`));
    const sweep2 = await auth(http().post('/api/gc/sweep'));
    expect(sweep2.body.tasks).toContain(taskId);
    expect(sweep2.body.divisions).toContain(divId);
    expect(await prisma.division.findUnique({ where: { id: divId } })).toBeNull();
    expect(await prisma.role.findUnique({ where: { id: inherentRole.id } })).toBeNull();
  });

  it('reconciles an orphaned blob (row gone, blob left behind)', async () => {
    const taskId = (
      await auth(http().post('/api/tasks')).send({ name: 'Orphan host', divisionId: writingId })
    ).body.id;
    const messageId = (
      await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'm' })
    ).body.id;
    const up = await auth(http().post(`/api/messages/${messageId}/attachments`)).attach(
      'file',
      Buffer.from('leak me'),
      { filename: 'leak.txt', contentType: 'text/plain' },
    );
    // Simulate a crash between DB delete and blob delete: drop the row, keep the blob.
    await prisma.attachment.delete({ where: { id: up.body.id } });

    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.orphanedBlobs).toBeGreaterThanOrEqual(1);
  });
});
