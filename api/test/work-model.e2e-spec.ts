import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { TaskStatusService } from '../src/tasks/task-status.service';
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
 * Phase 4 done-criteria: the settled slot rules (D28), completion as a fact (D5),
 * uploads that can't be stolen (D1), answerable attachment questions (D25), task
 * question edits that don't crash (D6), and openings of at least one (D27).
 */
describe('Work model', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let divisionId: string;
  let memberRoleId: string;
  let ana: { userId: string; session: AdminSession };
  let ben: { userId: string; session: AdminSession };

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession, r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin, r);
  const png = (bytes = 16) => Buffer.alloc(bytes, 7);

  /** A task from the default template (a required text and a required PNG). */
  async function makeTask(name = 'QA pass'): Promise<string> {
    const res = await auth(http().post('/api/tasks')).send({ name, divisionId, template: { kind: 'default' } });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function questions(taskId: string): Promise<{ report: string; shot: string }> {
    const res = await auth(http().get(`/api/tasks/${taskId}/request-template`));
    const [report, shot] = res.body.questions.map((q: { id: string }) => q.id);
    return { report, shot };
  }

  async function upload(who: AdminSession, taskId: string, body = png(), contentType = 'image/png') {
    return as(who, http().post(`/api/tasks/${taskId}/uploads`)).attach('file', body, { filename: 'shot.png', contentType });
  }

  /** Claim, upload a screenshot and submit; returns the submission id. */
  async function claimAndSubmit(who: { session: AdminSession }, taskId: string): Promise<string> {
    expect((await as(who.session, http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);
    const q = await questions(taskId);
    const file = await upload(who.session, taskId);
    expect(file.status).toBe(201);
    const res = await as(who.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [
        { questionId: q.report, value: 'Found two bugs' },
        { questionId: q.shot, attachmentIds: [file.body.id] },
      ],
    });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  const task = async (id: string) => (await auth(http().get(`/api/tasks/${id}`))).body;

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    memberRoleId = (await prisma.systemSettings.findFirstOrThrow()).memberRoleId!;
    divisionId = (await auth(http().post('/api/divisions')).send({ name: 'QA', defaultOpenings: 2 })).body.id;
    await auth(http().post(`/api/divisions/${divisionId}/request-templates`)).send({
      name: 'Bug report',
      isDefault: true,
      questions: [
        { type: 'text', prompt: 'What did you find?', required: true, constraints: {} },
        { type: 'attachment', prompt: 'Screenshot', required: true, constraints: { allowedTypes: ['image/png'], maxBytes: 100 } },
      ],
    });
    ana = await inviteAndAccept(booted, admin, { email: 'ana@example.com', intendedRoleIds: [memberRoleId] });
    ben = await inviteAndAccept(booted, admin, { email: 'ben@example.com', intendedRoleIds: [memberRoleId] });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  describe('attachment answers (D25) and safe uploads (D1)', () => {
    it('a task with a required attachment question can be submitted', async () => {
      const taskId = await makeTask();
      await as(ana.session, http().post(`/api/tasks/${taskId}/claim`));
      const body = png(40);
      const file = await upload(ana.session, taskId, body);
      expect(file.status).toBe(201);
      expect(file.body).toMatchObject({ taskId, messageId: null, answerId: null, byteSize: 40 });
      expect(file.body.checksum).toBe(createHash('sha256').update(body).digest('hex'));

      const q = await questions(taskId);
      const res = await as(ana.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [
          { questionId: q.report, value: 'All good' },
          { questionId: q.shot, attachmentIds: [file.body.id] },
        ],
      });
      expect(res.status).toBe(201);
      const answer = res.body.answers.find((a: { questionId: string }) => a.questionId === q.shot);
      expect(answer.attachmentIds).toEqual([file.body.id]);
    });

    it("another claimant can't submit someone else's upload, which stays theirs (D1)", async () => {
      const taskId = await makeTask();
      await as(ana.session, http().post(`/api/tasks/${taskId}/claim`));
      await as(ben.session, http().post(`/api/tasks/${taskId}/claim`));
      const anasFile = (await upload(ana.session, taskId)).body.id;
      const q = await questions(taskId);
      const theft = await as(ben.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [
          { questionId: q.report, value: 'Mine now' },
          { questionId: q.shot, attachmentIds: [anasFile] },
        ],
      });
      expect(theft.status).toBe(422);
      expect(theft.body.error.details.map((e: { code: string }) => e.code)).toContain('attachment_not_found');
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: anasFile } });
      expect(row).toMatchObject({ uploaderUserId: ana.userId, answerId: null, messageId: null });
    });

    it("a file posted on a message can't be pulled into a submission", async () => {
      const taskId = await makeTask();
      await as(ana.session, http().post(`/api/tasks/${taskId}/claim`));
      const msg = await as(ana.session, http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'look' });
      const posted = await as(ana.session, http().post(`/api/messages/${msg.body.id}/attachments`)).attach('file', png(), {
        filename: 'p.png',
        contentType: 'image/png',
      });
      expect(posted.status).toBe(201);
      const q = await questions(taskId);
      const res = await as(ana.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [
          { questionId: q.report, value: 'x' },
          { questionId: q.shot, attachmentIds: [posted.body.id] },
        ],
      });
      expect(res.status).toBe(422);
      expect((await prisma.attachment.findUniqueOrThrow({ where: { id: posted.body.id } })).messageId).toBe(msg.body.id);
    });

    it('a file over the question limit is refused at submit', async () => {
      const taskId = await makeTask();
      await as(ana.session, http().post(`/api/tasks/${taskId}/claim`));
      const big = (await upload(ana.session, taskId, png(200))).body.id;
      const q = await questions(taskId);
      const res = await as(ana.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [
          { questionId: q.report, value: 'x' },
          { questionId: q.shot, attachmentIds: [big] },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.details.map((e: { code: string }) => e.code)).toEqual(['file_too_large']);
    });

    it('only someone who can submit may upload for an answer', async () => {
      const taskId = await makeTask();
      expect((await upload(ben.session, taskId)).status).toBe(403);
    });
  });

  describe('slot rules (D28)', () => {
    it("a claimant can't leave after submitting", async () => {
      const taskId = await makeTask();
      await claimAndSubmit(ana, taskId);
      const res = await as(ana.session, http().post(`/api/tasks/${taskId}/leave`));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SUBMITTED_CANNOT_LEAVE');
      expect((await task(taskId)).claimantUserIds).toContain(ana.userId);
    });

    it('retiring a submission removes the claimant and opens the seat', async () => {
      const taskId = await makeTask();
      await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: -1 });
      const sub = await claimAndSubmit(ana, taskId);
      expect((await task(taskId)).statusCache).toBe('review');
      const res = await auth(http().post(`/api/submissions/${sub}/retire`)).send({ reason: 'Wrong build tested' });
      expect(res.status).toBe(200);
      const after = await task(taskId);
      expect(after.claimantUserIds).toEqual([]);
      expect(after.statusCache).toBe('open');
      // The seat is open to anyone, and a new tenure starts fresh.
      await claimAndSubmit(ben, taskId);
      expect((await task(taskId)).statusCache).toBe('review');
    });

    it('a rejected claimant keeps the seat but cannot resubmit', async () => {
      const taskId = await makeTask();
      const sub = await claimAndSubmit(ana, taskId);
      await auth(http().post(`/api/submissions/${sub}/review`)).send({ decision: 'reject' });
      expect((await task(taskId)).claimantUserIds).toContain(ana.userId);
      const q = await questions(taskId);
      const file = (await upload(ana.session, taskId)).body.id;
      const again = await as(ana.session, http().post(`/api/tasks/${taskId}/submissions`)).send({
        answers: [
          { questionId: q.report, value: 'Retry' },
          { questionId: q.shot, attachmentIds: [file] },
        ],
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ALREADY_SUBMITTED');
    });

    it("an evicted claimant's submission becomes a rejected record; they are told (D17)", async () => {
      const taskId = await makeTask();
      const sub = await claimAndSubmit(ana, taskId);
      const res = await auth(http().delete(`/api/tasks/${taskId}/claimants/${ana.userId}`));
      expect(res.status).toBe(200);
      expect(res.body.claimantUserIds).toEqual([]);
      expect(res.body.statusCache).toBe('open');
      const record = await auth(http().get(`/api/submissions/${sub}`));
      expect(record.body.state).toBe('rejected');
      // It can no longer be reviewed.
      expect((await auth(http().post(`/api/submissions/${sub}/review`)).send({ decision: 'approve' })).status).toBe(409);

      const timeline = (await auth(http().get(`/api/tasks/${taskId}/timeline`))).body;
      const evicted = timeline.find((e: { type: string }) => e.type === 'task.claimant_evicted');
      expect(evicted.payload).toEqual({ userId: ana.userId, submissionIds: [sub] });
      const notice = await prisma.notification.findFirst({
        where: { recipientUserId: ana.userId, type: 'task.claim_evicted', subjectId: taskId },
      });
      expect(notice).not.toBeNull();

      // Taking the seat again starts a new tenure: the old record doesn't count.
      await claimAndSubmit(ana, taskId);
      expect((await task(taskId)).statusCache).toBe('open');
    });
  });

  describe('completion is a fact (D5)', () => {
    let taskId: string;
    let outstanding: string;

    beforeAll(async () => {
      taskId = await makeTask();
      outstanding = await claimAndSubmit(ana, taskId);
    });

    it('completing records who and when, closes claims, and sets outstanding work aside', async () => {
      const res = await auth(http().post(`/api/tasks/${taskId}/complete`));
      expect(res.status).toBe(200);
      expect(res.body.statusCache).toBe('approved');
      expect(res.body.completedAt).not.toBeNull();
      expect(res.body.claimsClosed).toBe(true);
      const me = (await http().get('/api/me').set('Cookie', admin.cookies)).body;
      expect(res.body.completedBy).toBe(me.id);
      expect((await auth(http().get(`/api/submissions/${outstanding}`))).body.state).toBe('not_required');
    });

    it('a late claim is refused, and the task stays complete', async () => {
      const res = await as(ben.session, http().post(`/api/tasks/${taskId}/claim`));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TASK_COMPLETED');
      const reopen = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ claimsClosed: false });
      expect(reopen.body.error.code).toBe('TASK_COMPLETED');
      expect((await task(taskId)).statusCache).toBe('approved');
    });

    it('completion is terminal', async () => {
      const again = await auth(http().post(`/api/tasks/${taskId}/complete`));
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ALREADY_COMPLETED');
    });

    it('a status cache that drifts is rebuilt from the facts', async () => {
      await prisma.task.update({ where: { id: taskId }, data: { statusCache: 'open' } });
      const fixed = await app.get(TaskStatusService).rebuild();
      expect(fixed).toContain(taskId);
      expect((await task(taskId)).statusCache).toBe('approved');
      expect(await app.get(TaskStatusService).rebuild()).toEqual([]);
    });
  });

  describe("a task's own questions (D6)", () => {
    it('after a retired submission, an answered question can be edited but not deleted', async () => {
      const taskId = await makeTask();
      const sub = await claimAndSubmit(ana, taskId);
      const locked = await auth(http().put(`/api/tasks/${taskId}/request-template`)).send({ questions: [] });
      expect(locked.body.error.code).toBe('REQUEST_TEMPLATE_LOCKED');

      await auth(http().post(`/api/submissions/${sub}/retire`)).send({ reason: 'Start over please' });
      const current = (await auth(http().get(`/api/tasks/${taskId}/request-template`))).body;
      expect(current.locked).toBe(false);

      const drop = await auth(http().put(`/api/tasks/${taskId}/request-template`)).send({ questions: [] });
      expect(drop.status).toBe(409);
      expect(drop.body.error.code).toBe('QUESTION_HAS_ANSWERS');

      const edit = await auth(http().put(`/api/tasks/${taskId}/request-template`)).send({
        questions: current.questions.map((q: Record<string, unknown>) => ({
          id: q.id,
          type: q.type,
          prompt: `${q.prompt as string} (v2)`,
          required: q.required,
          constraints: q.constraints,
        })),
      });
      expect(edit.status).toBe(200);
      expect(edit.body.questions.map((q: { id: string }) => q.id)).toEqual(current.questions.map((q: { id: string }) => q.id));
    });
  });

  describe('openings are at least one (D27)', () => {
    it('a division cannot default to zero openings', async () => {
      const res = await auth(http().post('/api/divisions')).send({ name: 'Empty seats', defaultOpenings: 0 });
      expect(res.status).toBe(422);
    });

    it('a task cannot drop to zero openings', async () => {
      const taskId = await makeTask();
      const res = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: -2 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_OPENINGS');
    });

    it('openings_locked blocks adding openings, not removing them', async () => {
      const taskId = await makeTask();
      await auth(http().patch(`/api/divisions/${divisionId}`)).send({ openingsLocked: true });
      const more = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: 1 });
      expect(more.body.error.code).toBe('OPENINGS_LOCKED');
      const fewer = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: -1 });
      expect(fewer.status).toBe(200);
      expect(fewer.body.openings).toBe(1);
      await auth(http().patch(`/api/divisions/${divisionId}`)).send({ openingsLocked: false });
    });
  });

  it('GC collects pending uploads nobody claimed', async () => {
    const taskId = await makeTask();
    await as(ben.session, http().post(`/api/tasks/${taskId}/claim`));
    const id = (await upload(ben.session, taskId)).body.id;
    await prisma.attachment.update({ where: { id }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.pendingUploads).toBe(1);
    expect(await prisma.attachment.findUnique({ where: { id } })).toBeNull();
  });
});
