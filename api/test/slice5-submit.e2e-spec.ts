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

/** Slice 5.1 — task:submit + answers + validateSubmission + first-submission lock + M1 (#21). */
describe('Slice 5.1 — Submit, validation, questionnaire lock', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let claimer: { userId: string; session: AdminSession };

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    const writing = await auth(http().post('/api/divisions')).send({ name: 'Writing' });
    writingId = writing.body.id;
    // A required Detail-Text + an optional Numeric (range 1..10) to exercise validation.
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [
        { type: 'detail_text', prompt: 'Body', required: true, constraints: { minChars: 3 } },
        { type: 'numeric', prompt: 'Rating', required: false, constraints: { kind: 'integer', min: 1, max: 10 } },
      ],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of ['task:create', 'task:assign', 'task:submit', 'task:configure_questionnaire']) {
      const g = await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: 'global' });
      expect(g.status).toBe(201);
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    const claimerRoleId = claimerRole.body.id;
    for (const action of ['task:assign', 'task:submit']) {
      await auth(http().post('/api/grants')).send({ roleId: claimerRoleId, action, scopeKind: 'own' });
    }
    claimer = await inviteAndAccept(booted, admin, { email: 'c@example.com', intendedRoleIds: [claimerRoleId] });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  async function makeClaimedTask(): Promise<{ taskId: string; questionIds: string[] }> {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId });
    const taskId = res.body.id;
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    return { taskId, questionIds: qn.body.questions.map((q: any) => q.id) };
  }

  it('a non-claimant cannot submit (Cedar 403 — own_as_claimant)', async () => {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId });
    const taskId = res.body.id;
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    // claimer holds no slot here → own_as_claimant doesn't match.
    const denied = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId: qn.body.questions[0].id, value: 'hello there' }],
    });
    expect(denied.status).toBe(403);
  });

  it('rejects an invalid submission (required missing / out of range) with 422', async () => {
    const { taskId, questionIds } = await makeClaimedTask();
    const missing = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId: questionIds[1], value: 5 }], // required detail-text omitted
    });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('INVALID_SUBMISSION');

    const outOfRange = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [
        { questionId: questionIds[0], value: 'a valid body' },
        { questionId: questionIds[1], value: 99 },
      ],
    });
    expect(outOfRange.status).toBe(422);
  });

  it('a valid first submission lands in review, marks the slot, and emits M1', async () => {
    const { taskId, questionIds } = await makeClaimedTask();
    const res = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId: questionIds[0], value: 'my deliverable text' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('review');
    expect(res.body.submissionNo).toBe(1);

    const task = await auth(http().get(`/api/tasks/${taskId}`));
    expect(task.body.statusCache).toBe('review');

    const slot = await prisma.taskClaimant.findFirstOrThrow({ where: { taskId, userId: claimer.userId } });
    expect(slot.hasSubmitted).toBe(true);

    // M1: a top-level system message bound to this submission's thread.
    const m1 = await prisma.message.findFirstOrThrow({
      where: { taskId, submissionId: res.body.id, parentMessageId: null, kind: 'system' },
    });
    expect(m1).not.toBeNull();

    // Activity row, IDs only.
    const act = await prisma.activity.findFirstOrThrow({
      where: { verb: 'submission.submitted', subjectId: res.body.id },
    });
    expect((act.payload as any).claimantUserId).toBe(claimer.userId);
  });

  it('locks the questionnaire once a submission exists (configure → 409)', async () => {
    const { taskId, questionIds } = await makeClaimedTask();
    // Before any submission, configuring is fine.
    const before = await auth(http().put(`/api/tasks/${taskId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'X', required: false, constraints: {} }],
    });
    expect(before.status).toBe(200);

    // Re-read the (now single-question) questionnaire and submit against it.
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    const sub = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId: qn.body.questions[0].id, value: 'anything' }],
    });
    expect(sub.status).toBe(201);

    const locked = await auth(http().put(`/api/tasks/${taskId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Y', required: false, constraints: {} }],
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('QUESTIONNAIRE_LOCKED');
  });
});
