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

/** retire_submission, complete, Empty Contributing Set Floor (#23). */
describe('Retire-submission & manual complete', () => {
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
    await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({ name: 'Default', isDefault: true,
      questions: [{ type: 'text', prompt: 'Answer', required: true, constraints: {} }],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of ['task:create', 'task:assign', 'task:submit', 'task:review', 'task:retire_submission', 'task:complete', 'task:manage_claims']) {
      const scoped = ['task:review', 'task:retire_submission', 'task:complete'].includes(action);
      await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: scoped ? 'own' : 'global' });
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    const claimerRoleId = claimerRole.body.id;
    for (const action of ['task:assign', 'task:submit']) {
      await auth(http().post('/api/grants')).send({ roleId: claimerRoleId, action, scopeKind: action === 'task:assign' ? 'global' : 'own' });
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

  async function claimedSubmission(): Promise<{ taskId: string; submissionId: string }> {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId, template: { kind: 'default' } });
    const taskId = res.body.id;
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));
    const qn = await auth(http().get(`/api/tasks/${taskId}/request-template`));
    const sub = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId: qn.body.questions[0].id, value: 'my work' }],
    });
    expect(sub.status).toBe(201);
    return { taskId, submissionId: sub.body.id };
  }

  it('rejects a retire with a missing/short reason (422)', async () => {
    const { submissionId } = await claimedSubmission();
    expect((await auth(http().post(`/api/submissions/${submissionId}/retire`)).send({})).status).toBe(422);
    expect((await auth(http().post(`/api/submissions/${submissionId}/retire`)).send({ reason: 'no' })).status).toBe(422);
  });

  it('retire records a timeline entry with the reason and opens the seat', async () => {
    const { taskId, submissionId } = await claimedSubmission();

    const res = await auth(http().post(`/api/submissions/${submissionId}/retire`)).send({
      reason: 'spam / junk submission',
    });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleState).toBe('retired');

    // The timeline entry carries the reason; it's the only place the reason is kept.
    const timeline = (await auth(http().get(`/api/tasks/${taskId}/timeline`))).body;
    const retired = timeline.find((e: { type: string }) => e.type === 'submission.retired');
    expect(retired.payload).toMatchObject({ submissionId, reason: 'spam / junk submission' });

    // The claimant leaves the seat, which opens for anyone (intent-vs-reality §6.1).
    const slot = await prisma.taskClaimant.findFirstOrThrow({ where: { taskId, userId: claimer.userId } });
    expect(slot.leftAt).not.toBeNull();
    const after = (await auth(http().get(`/api/tasks/${taskId}`))).body;
    expect(after.claimantUserIds).toEqual([]);
    expect(after.statusCache).toBe('open');

    // The audit row points at the timeline entry; the free-text reason stays out of it.
    const act = await prisma.activity.findFirstOrThrow({ where: { verb: 'submission.retired', subjectId: submissionId } });
    expect((act.payload as any).reason).toBeUndefined();
    expect((act.payload as any).eventId).toBe(retired.id);
  });

  it('Empty Contributing Set Floor: a lone rejected submission ⇒ claimed (never approved)', async () => {
    const { taskId, submissionId } = await claimedSubmission();
    await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ claimsClosed: true });
    expect((await auth(http().post(`/api/submissions/${submissionId}/review`)).send({ decision: 'reject' })).status).toBe(200);
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('claimed');
  });

  it('manual complete forces approved regardless of an outstanding submission', async () => {
    const { taskId } = await claimedSubmission();
    // Submission is in review; complete bypasses it.
    expect((await auth(http().get(`/api/tasks/${taskId}`))).body.statusCache).toBe('review');
    const done = await auth(http().post(`/api/tasks/${taskId}/complete`));
    expect(done.status).toBe(200);
    expect(done.body.statusCache).toBe('approved');

    const act = await prisma.activity.findFirst({ where: { verb: 'task.completed', subjectId: taskId } });
    expect(act).not.toBeNull();
  });
});
