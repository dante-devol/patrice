import { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Slice 4.3 — messages, threading, attachments (local-fs), system messages (#19). */
describe('Messages, attachments and the task timeline', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let storageDir: string;
  let writingId: string;
  let taskId: string;
  let claimer: { userId: string; session: AdminSession };

  beforeAll(async () => {
    await resetDatabase();
    storageDir = mkdtempSync(join(tmpdir(), 'patrice-e2e-storage-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_DIR = storageDir;

    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({ name: 'Default', isDefault: true,
      questions: [{ type: 'text', prompt: 'T', required: false, constraints: {} }],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of [
      'task:create', 'task:assign', 'task:change_requester',
      'message:create', 'message:update', 'message:delete', 'attachment:create',
    ]) {
      const g = await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: 'global' });
      expect(g.status).toBe(201);
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    await auth(http().post('/api/grants')).send({ roleId: claimerRole.body.id, action: 'task:assign', scopeKind: 'own' });
    await auth(http().post('/api/grants')).send({ roleId: claimerRole.body.id, action: 'task:leave', scopeKind: 'own' });
    claimer = await inviteAndAccept(booted, admin, { email: 'claimer@example.com', intendedRoleIds: [claimerRole.body.id] });

    taskId = (await auth(http().post('/api/tasks')).send({ name: 'Thread host', divisionId: writingId, template: { kind: 'default' } })).body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  describe('threading', () => {
    let topId: string;
    let replyId: string;

    it('posts a top-level comment', async () => {
      const res = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'Top level' });
      expect(res.status).toBe(201);
      expect(res.body.parentMessageId).toBeNull();
      expect(res.body.deletedAt).toBeNull();
      topId = res.body.id;
    });

    it('posts a one-level reply', async () => {
      const res = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'A reply', parentMessageId: topId });
      expect(res.status).toBe(201);
      expect(res.body.parentMessageId).toBe(topId);
      replyId = res.body.id;
    });

    it('rejects a reply-to-reply at the app boundary (422)', async () => {
      const res = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'nope', parentMessageId: replyId });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REPLY_TO_REPLY');
    });

    it('the DB trigger is the backstop for reply-to-reply', async () => {
      await expect(
        prisma.message.create({ data: { taskId, body: 'direct', parentMessageId: replyId } }),
      ).rejects.toThrow();
    });

    it('lists top-level messages with their nested replies', async () => {
      const res = await auth(http().get(`/api/tasks/${taskId}/messages`));
      expect(res.status).toBe(200);
      const top = res.body.items.find((m: any) => m.id === topId);
      expect(top).toBeTruthy();
      expect(top.replies.map((r: any) => r.id)).toContain(replyId);
    });
  });

  describe('edit + delete', () => {
    it('edits a message (sets editedAt, bumps version)', async () => {
      const created = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'original' });
      const res = await auth(http().patch(`/api/messages/${created.body.id}`)).send({ body: 'edited' });
      expect(res.status).toBe(200);
      expect(res.body.body).toBe('edited');
      expect(res.body.editedAt).not.toBeNull();
      expect(res.body.version).toBeGreaterThan(0);
    });

    it('deletes a message permanently, with an audit row', async () => {
      const created = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'to delete' });
      const res = await auth(http().delete(`/api/messages/${created.body.id}`));
      expect(res.status).toBe(204);
      expect(await prisma.message.findUnique({ where: { id: created.body.id } })).toBeNull();
      const audit = await prisma.activity.findFirstOrThrow({ where: { verb: 'message.deleted', subjectId: created.body.id } });
      expect(audit.payload).toMatchObject({ keptAsMarker: false });
    });

    it('a deleted message with replies stays as an empty marker', async () => {
      const top = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'has replies' });
      await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'reply', parentMessageId: top.body.id });
      expect((await auth(http().delete(`/api/messages/${top.body.id}`))).status).toBe(204);
      const list = await auth(http().get(`/api/tasks/${taskId}/messages?limit=100`));
      const marker = list.body.items.find((m: { id: string }) => m.id === top.body.id);
      expect(marker.body).toBe('');
      expect(marker.deletedAt).not.toBeNull();
      expect(marker.replies).toHaveLength(1);
      // A deleted message can't be edited or deleted again.
      expect((await auth(http().patch(`/api/messages/${top.body.id}`)).send({ body: 'x' })).status).toBe(404);
    });
  });

  describe('attachments (local-fs round-trip)', () => {
    let messageId: string;
    beforeAll(async () => {
      messageId = (await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'has attachment' })).body.id;
    });

    it('uploads a file and records metadata', async () => {
      const res = await auth(
        http().post(`/api/messages/${messageId}/attachments`),
      ).attach('file', Buffer.from('hello attachment'), { filename: 'note.txt', contentType: 'text/plain' });
      expect(res.status).toBe(201);
      expect(res.body.filename).toBe('note.txt');
      expect(res.body.contentType).toBe('text/plain');
      expect(res.body.kind).toBe('text');
      expect(res.body.byteSize).toBe(16);
      expect(res.body.messageId).toBe(messageId);

      // The message now reports its attachment.
      const msg = await auth(http().get(`/api/tasks/${taskId}/messages`));
      const m = msg.body.items.find((x: any) => x.id === messageId);
      expect(m.attachments).toHaveLength(1);
    });

    it('downloads the file (ungated read) and round-trips the bytes', async () => {
      const up = await auth(
        http().post(`/api/messages/${messageId}/attachments`),
      ).attach('file', Buffer.from('round trip body'), { filename: 'rt.txt', contentType: 'text/plain' });
      const res = await auth(http().get(`/api/attachments/${up.body.id}`));
      expect(res.status).toBe(200);
      expect(res.text).toBe('round trip body');
    });

    it('CHECK rejects an attachment owning both message and answer', async () => {
      const uploader = (await prisma.appUser.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO attachment (message_id, answer_id, uploader_user_id, storage_key, filename, content_type, byte_size)
           VALUES ($1::uuid, gen_random_uuid(), $2::uuid, 'k', 'f', 'text/plain', 1)`,
          messageId, uploader,
        ),
      ).rejects.toThrow();
    });

    it('CHECK rejects an attachment owning neither', async () => {
      const uploader = (await prisma.appUser.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO attachment (uploader_user_id, storage_key, filename, content_type, byte_size)
           VALUES ($1::uuid, 'k', 'f', 'text/plain', 1)`,
          uploader,
        ),
      ).rejects.toThrow();
    });
  });

  describe('timeline', () => {
    const timeline = async (t: string) => (await auth(http().get(`/api/tasks/${t}/timeline`))).body;

    it('records a typed claim event, and the thread holds only comments', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Claim me', divisionId: writingId, template: { kind: 'default' } })).body.id;
      await as(claimer.session)(http().post(`/api/tasks/${t}/claim`));
      const events = await timeline(t);
      expect(events.map((e: { type: string }) => e.type)).toEqual(['task.created', 'task.claimed']);
      expect(events[1]).toMatchObject({ actorUserId: claimer.userId, payload: { userId: claimer.userId } });
      expect(await prisma.message.count({ where: { taskId: t } })).toBe(0);
    });

    it('records claim then leave', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Leave me', divisionId: writingId, template: { kind: 'default' } })).body.id;
      await as(claimer.session)(http().post(`/api/tasks/${t}/claim`));
      await as(claimer.session)(http().post(`/api/tasks/${t}/leave`));
      expect((await timeline(t)).map((e: { type: string }) => e.type)).toEqual([
        'task.created',
        'task.claimed',
        'task.left',
      ]);
    });

    it('records a requester change with both ends', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Reassign', divisionId: writingId, template: { kind: 'default' } })).body.id;
      await auth(http().post(`/api/tasks/${t}/requester`)).send({ userId: claimer.userId });
      const change = (await timeline(t)).find((e: { type: string }) => e.type === 'task.requester_changed');
      expect(change.payload.toUserId).toBe(claimer.userId);
    });
  });
});
