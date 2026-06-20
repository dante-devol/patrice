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

/** Slice 4.2 — claiming, openings, change-requester; eligibility enforced in Cedar (#18). */
describe('Slice 4.2 — Claiming, openings, requester', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string; // restrict_claims = false
  let secretId: string; // restrict_claims = true
  let secretRoleId: string; // Secret's inherent role
  let userA: { userId: string; session: AdminSession };
  let userB: { userId: string; session: AdminSession }; // Secret member
  let userC: { userId: string; session: AdminSession };

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    const writing = await auth(http().post('/api/divisions')).send({ name: 'Writing' });
    writingId = writing.body.id;
    const secret = await auth(http().post('/api/divisions')).send({ name: 'Secret', restrictClaims: true });
    secretId = secret.body.id;
    secretRoleId = secret.body.inherentRoleId;

    for (const d of [writingId, secretId]) {
      await auth(http().put(`/api/divisions/${d}/questionnaire`)).send({
        questions: [{ type: 'text', prompt: 'T', required: false, constraints: {} }],
      });
    }

    // Admin role gets the global task authorities used to set up + manage.
    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of ['task:create', 'task:assign', 'task:manage_claims', 'task:change_requester']) {
      const g = await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: 'global' });
      expect(g.status).toBe(201);
    }

    // A standalone role that lets a holder self-claim anywhere eligibility permits.
    const claimer = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    const claimerId = claimer.body.id;
    await auth(http().post('/api/grants')).send({ roleId: claimerId, action: 'task:assign', scopeKind: 'own' });

    userA = await inviteAndAccept(booted, admin, { email: 'a@example.com', intendedRoleIds: [claimerId] });
    userB = await inviteAndAccept(booted, admin, { email: 'b@example.com', intendedRoleIds: [claimerId, secretRoleId] });
    userC = await inviteAndAccept(booted, admin, { email: 'c@example.com', intendedRoleIds: [claimerId] });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  async function makeTask(divisionId: string): Promise<string> {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  it('self-claim succeeds for an eligible user and fills the opening', async () => {
    const taskId = await makeTask(writingId);
    const res = await as(userA.session)(http().post(`/api/tasks/${taskId}/claim`));
    expect(res.status).toBe(200);
    expect(res.body.statusCache).toBe('claimed');

    const slot = await prisma.taskClaimant.findFirst({ where: { taskId, userId: userA.userId } });
    expect(slot).not.toBeNull();
    expect(slot!.leftAt).toBeNull();
  });

  it('refuses a self-claim blocked by division restrict_claims (Cedar, not app-guard)', async () => {
    const taskId = await makeTask(secretId);
    // userA is not a Secret member → Cedar denies (403), not a 409/422 app error.
    const denied = as(userA.session)(http().post(`/api/tasks/${taskId}/claim`));
    expect((await denied).status).toBe(403);

    // userB holds the Secret inherent role → eligibility passes.
    const ok = as(userB.session)(http().post(`/api/tasks/${taskId}/claim`));
    expect((await ok).status).toBe(200);
  });

  it('over-claim is rejected; adding an opening lets a second claimant in', async () => {
    const taskId = await makeTask(writingId);
    expect((await as(userA.session)(http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);

    const full = await as(userC.session)(http().post(`/api/tasks/${taskId}/claim`));
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('NO_OPENINGS');

    const add = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: 1 });
    expect(add.status).toBe(200);
    expect(add.body.openings).toBe(2);

    expect((await as(userC.session)(http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);
  });

  it('closing the task blocks new claims', async () => {
    const taskId = await makeTask(writingId);
    const close = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ claimsClosed: true });
    expect(close.status).toBe(200);
    expect(close.body.statusCache).toBe('claimed');

    const res = await as(userA.session)(http().post(`/api/tasks/${taskId}/claim`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CLAIMS_CLOSED');
  });

  it('leaving frees the slot and moves status back toward open', async () => {
    const taskId = await makeTask(writingId);
    expect((await as(userA.session)(http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);

    const left = await as(userA.session)(http().post(`/api/tasks/${taskId}/leave`));
    expect(left.status).toBe(200);
    expect(left.body.statusCache).toBe('open');

    const slot = await prisma.taskClaimant.findFirst({ where: { taskId, userId: userA.userId } });
    expect(slot!.leftAt).not.toBeNull();

    // Freed spot is claimable again.
    expect((await as(userC.session)(http().post(`/api/tasks/${taskId}/claim`))).status).toBe(200);
  });

  it('change_requester reassigns and writes an activity row', async () => {
    const taskId = await makeTask(writingId);
    const res = await auth(http().post(`/api/tasks/${taskId}/requester`)).send({ userId: userA.userId });
    expect(res.status).toBe(200);
    expect(res.body.requesterUserId).toBe(userA.userId);

    const row = await prisma.activity.findFirst({
      where: { verb: 'task.requester_changed', subjectId: taskId },
    });
    expect(row).not.toBeNull();
    expect((row!.payload as any).requesterUserId).toBe(userA.userId);
  });

  it('manage_claims works independently of claim eligibility', async () => {
    // Admin is not a Secret member, yet may add an opening on a Secret task —
    // manage_claims is requester/admin authority, not the eligibility clause.
    const taskId = await makeTask(secretId);
    const res = await auth(http().post(`/api/tasks/${taskId}/claims`)).send({ openingsDelta: 1 });
    expect(res.status).toBe(200);
    expect(res.body.openings).toBe(2);
  });

  it('lists tasks filtered by active claimant', async () => {
    const taskId = await makeTask(writingId);
    await as(userA.session)(http().post(`/api/tasks/${taskId}/claim`));
    const res = await auth(http().get(`/api/tasks?claimant=${userA.userId}`));
    expect(res.status).toBe(200);
    expect(res.body.items.some((t: any) => t.id === taskId)).toBe(true);
  });
});
