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
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/** Slice 5.2 — task:review (approve/return/reject), state-machine + version guard, min-rule (#22). */
describe('Slice 5.2 — Review lifecycle', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let questionId: string;
  let reviewerRoleId: string; // task:review @ own (own_as_requester)
  let claimer: { userId: string; session: AdminSession };
  let other: { userId: string; session: AdminSession };

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    const writing = await auth(http().post('/api/divisions')).send({ name: 'Writing', defaultOpenings: 1 });
    writingId = writing.body.id;
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Answer', required: true, constraints: {} }],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    // Admin requests + reviews (own_as_requester) and manages claims.
    for (const action of ['task:create', 'task:assign', 'task:submit', 'task:review', 'task:manage_claims']) {
      await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: action === 'task:review' ? 'own' : 'global' });
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    const claimerRoleId = claimerRole.body.id;
    for (const action of ['task:assign', 'task:submit']) {
      await auth(http().post('/api/grants')).send({ roleId: claimerRoleId, action, scopeKind: 'own' });
    }
    claimer = await inviteAndAccept(booted, admin, { email: 'c@example.com', intendedRoleIds: [claimerRoleId] });
    other = await inviteAndAccept(booted, admin, { email: 'o@example.com', intendedRoleIds: [claimerRoleId] });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  async function setup(openings = 1): Promise<{ taskId: string; qId: string }> {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId });
    const taskId = res.body.id;
    if (openings > 1) {
      await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: openings - 1 });
    }
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    return { taskId, qId: qn.body.questions[0].id };
  }

  async function submit(taskId: string, qId: string, who: AdminSession, value = 'hi there') {
    const r = await as(who)(http().post(`/api/tasks/${taskId}/submissions`)).send({ answers: [{ questionId: qId, value }] });
    expect(r.status).toBe(201);
    return r.body;
  }

  it('full single-claimant cycle: submit → return → resubmit(v2) → approve', async () => {
    const { taskId, qId } = await setup();
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));
    const v1 = await submit(taskId, qId, claimer.session);

    // Requester returns it (status → revising).
    const ret = await auth(http().post(`/api/submissions/${v1.id}/review`)).send({ decision: 'return', comment: 'add detail' });
    expect(ret.status).toBe(200);
    expect(ret.body.state).toBe('revising');
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('revising');

    // Reviewing an already-decided submission is an invalid transition (409).
    const stale = await auth(http().post(`/api/submissions/${v1.id}/review`)).send({ decision: 'approve' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('INVALID_TRANSITION');

    // Claimant resubmits → v2 (new top-level message), chained to v1.
    const v2 = await submit(taskId, qId, claimer.session, 'much more detail now');
    expect(v2.submissionNo).toBe(2);
    expect(v2.prevSubmissionId).toBe(v1.id);
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('review');

    const m2 = await prisma.message.findFirst({
      where: { taskId, submissionId: v2.id, parentMessageId: null, kind: 'system' },
    });
    expect(m2).not.toBeNull();

    // Approve v2 → task approved.
    const appr = await auth(http().post(`/api/submissions/${v2.id}/review`)).send({ decision: 'approve' });
    expect(appr.status).toBe(200);
    expect(appr.body.state).toBe('approved');
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('approved');

    // The return decision is a reply threaded under v1's M1.
    const m1 = await prisma.message.findFirstOrThrow({ where: { taskId, submissionId: v1.id, parentMessageId: null } });
    const reply = await prisma.message.findFirst({ where: { parentMessageId: m1.id, kind: 'system' } });
    expect(reply).not.toBeNull();
  });

  it('multi-claimant min-rule: reject excludes; approving the rest ⇒ approved', async () => {
    const { taskId, qId } = await setup(2);
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));
    await as(other.session)(http().post(`/api/tasks/${taskId}/claim`));
    await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ claimsClosed: true });

    const a = await submit(taskId, qId, claimer.session);
    const b = await submit(taskId, qId, other.session);

    // {review, review} ⇒ review.
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('review');

    // Reject one, approve the other → rejected excluded ⇒ approved.
    expect((await auth(http().post(`/api/submissions/${a.id}/review`)).send({ decision: 'reject' })).status).toBe(200);
    expect((await auth(http().post(`/api/submissions/${b.id}/review`)).send({ decision: 'approve' })).status).toBe(200);
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('approved');
  });

  it('self-review is forbidden by Cedar when selfReviewAllowed=false', async () => {
    // Admin requests AND claims the same task, then tries to review their own submission.
    const { taskId, qId } = await setup();
    await auth(http().post(`/api/tasks/${taskId}/claim`)); // admin has task:assign @ global
    const mine = await submit(taskId, qId, admin);
    const denied = await auth(http().post(`/api/submissions/${mine.id}/review`)).send({ decision: 'approve' });
    expect(denied.status).toBe(403);
  });

  it('self-review is allowed once selfReviewAllowed=true', async () => {
    await auth(http().patch('/api/config')).send({ selfReviewAllowed: true });
    const { taskId, qId } = await setup();
    await auth(http().post(`/api/tasks/${taskId}/claim`));
    const mine = await submit(taskId, qId, admin);
    const ok = await auth(http().post(`/api/submissions/${mine.id}/review`)).send({ decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('approved');
    // Restore default for any later suites sharing the org.
    await auth(http().patch('/api/config')).send({ selfReviewAllowed: false });
  });
});
