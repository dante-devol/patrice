/* eslint-disable */
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
describe('Slice 4.3 — Messages, attachments, system messages', () => {
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
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'T', required: false, constraints: {} }],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of [
      'task:create', 'task:assign', 'task:change_requester',
      'message:create', 'message:update', 'message:retire', 'attachment:create',
    ]) {
      const g = await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: 'global' });
      expect(g.status).toBe(201);
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    await auth(http().post('/api/grants')).send({ roleId: claimerRole.body.id, action: 'task:assign', scopeKind: 'own' });
    claimer = await inviteAndAccept(booted, admin, { email: 'claimer@example.com', intendedRoleIds: [claimerRole.body.id] });

    taskId = (await auth(http().post('/api/tasks')).send({ name: 'Thread host', divisionId: writingId })).body.id;
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
      expect(res.body.kind).toBe('comment');
      expect(res.body.parentMessageId).toBeNull();
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

  describe('edit + retire', () => {
    it('edits a message (sets editedAt, bumps version)', async () => {
      const created = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'original' });
      const res = await auth(http().patch(`/api/messages/${created.body.id}`)).send({ body: 'edited' });
      expect(res.status).toBe(200);
      expect(res.body.body).toBe('edited');
      expect(res.body.editedAt).not.toBeNull();
      expect(res.body.version).toBeGreaterThan(0);
    });

    it('soft-retires a message', async () => {
      const created = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'to retire' });
      const res = await auth(http().post(`/api/messages/${created.body.id}/retire`));
      expect(res.status).toBe(200);
      expect(res.body.lifecycleState).toBe('retired');
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
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const uploader = (await prisma.appUser.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO attachment (organization_id, message_id, answer_id, uploader_user_id, storage_key, filename, content_type, byte_size)
           VALUES ($1::uuid, $2::uuid, gen_random_uuid(), $3::uuid, 'k', 'f', 'text/plain', 1)`,
          orgId, messageId, uploader,
        ),
      ).rejects.toThrow();
    });

    it('CHECK rejects an attachment owning neither', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      const uploader = (await prisma.appUser.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO attachment (organization_id, uploader_user_id, storage_key, filename, content_type, byte_size)
           VALUES ($1::uuid, $2::uuid, 'k', 'f', 'text/plain', 1)`,
          orgId, uploader,
        ),
      ).rejects.toThrow();
    });
  });

  describe('system messages', () => {
    it('emits a system message on claim', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Claim me', divisionId: writingId })).body.id;
      await as(claimer.session)(http().post(`/api/tasks/${t}/claim`));
      const sys = await prisma.message.findFirst({ where: { taskId: t, kind: 'system' } });
      expect(sys).not.toBeNull();
      expect(sys!.senderUserId).toBeNull();
      expect(sys!.body).toContain(claimer.userId);
    });

    it('emits a system message on leave', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Leave me', divisionId: writingId })).body.id;
      await as(claimer.session)(http().post(`/api/tasks/${t}/claim`));
      await as(claimer.session)(http().post(`/api/tasks/${t}/leave`));
      const count = await prisma.message.count({ where: { taskId: t, kind: 'system' } });
      expect(count).toBe(2); // claim + leave
    });

    it('emits a system message on requester change', async () => {
      const t = (await auth(http().post('/api/tasks')).send({ name: 'Reassign', divisionId: writingId })).body.id;
      await auth(http().post(`/api/tasks/${t}/requester`)).send({ userId: claimer.userId });
      const sys = await prisma.message.findFirst({ where: { taskId: t, kind: 'system' } });
      expect(sys!.body).toContain(claimer.userId);
    });
  });
});
