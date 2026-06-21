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
import { NotificationsService } from '../src/notifications/notifications.service';
import { PUBSUB_PORT, PubSubPort } from '../src/notifications/pubsub.port';

/**
 * Slice 6 — Notifications (#24/#25/#26). Recipient matrix + sender suppression +
 * idempotent insertion (6.1); SSE fan-out, reconcile pull, and read-state (6.2).
 */
describe('Slice 6 — Notifications', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession; // the requester for every task here
  let prisma: PrismaClient;
  let adminUserId: string;
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
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [
        { type: 'detail_text', prompt: 'Body', required: true, constraints: { minChars: 3 } },
      ],
    });

    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    adminUserId = adminUser.id;
    const adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of [
      'task:create',
      'task:assign',
      'task:submit',
      'task:review',
      'task:complete',
      'message:create',
    ]) {
      const g = await auth(http().post('/api/grants')).send({ roleId: adminRoleId, action, scopeKind: 'global' });
      expect(g.status).toBe(201);
    }

    const claimerRole = await auth(http().post('/api/roles')).send({ name: 'Claimer' });
    const claimerRoleId = claimerRole.body.id;
    for (const action of ['task:assign', 'task:submit', 'message:create']) {
      await auth(http().post('/api/grants')).send({ roleId: claimerRoleId, action, scopeKind: 'own' });
    }
    claimer = await inviteAndAccept(booted, admin, {
      email: 'c@example.com',
      intendedRoleIds: [claimerRoleId],
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);

  /** Notifications addressed to a user, optionally of a given type. */
  function notifs(userId: string, type?: string) {
    return prisma.notification.findMany({
      where: { recipientUserId: userId, ...(type ? { type } : {}) },
    });
  }

  async function makeClaimedTask(): Promise<{ taskId: string; questionId: string }> {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId });
    const taskId = res.body.id;
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    return { taskId, questionId: qn.body.questions[0].id };
  }

  it('claim notifies the requester, not the claimant (sender suppressed)', async () => {
    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: writingId });
    const taskId = res.body.id;
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/claim`));

    const toRequester = await notifs(adminUserId, 'task.claim_joined');
    expect(toRequester.some((n) => n.subjectId === taskId)).toBe(true);
    // The claimant (sender) gets nothing for their own claim.
    const toClaimer = (await notifs(claimer.userId, 'task.claim_joined')).filter(
      (n) => n.subjectId === taskId,
    );
    expect(toClaimer).toHaveLength(0);
  });

  it('submit → requester; review(approve) → claimant; complete → claimant', async () => {
    const { taskId, questionId } = await makeClaimedTask();
    const sub = await as(claimer.session)(http().post(`/api/tasks/${taskId}/submissions`)).send({
      answers: [{ questionId, value: 'my deliverable' }],
    });
    expect(sub.status).toBe(201);
    const submissionId = sub.body.id;

    // task.submitted → requester only; claimant (sender) suppressed.
    expect((await notifs(adminUserId, 'task.submitted')).some((n) => n.subjectId === submissionId)).toBe(true);
    expect((await notifs(claimer.userId, 'task.submitted'))).toHaveLength(0);

    // review(approve) → the submission's claimant.
    const rev = await auth(http().post(`/api/submissions/${submissionId}/review`)).send({ decision: 'approve' });
    expect(rev.status).toBe(200);
    const approved = (await notifs(claimer.userId, 'task.reviewed_approved')).filter(
      (n) => n.subjectId === submissionId,
    );
    expect(approved).toHaveLength(1);
    expect((approved[0].payload as any).decision).toBe('approve');

    // complete → all active claimants.
    const done = await auth(http().post(`/api/tasks/${taskId}/complete`));
    expect(done.status).toBe(200);
    expect((await notifs(claimer.userId, 'task.completed')).some((n) => n.subjectId === taskId)).toBe(true);
  });

  it('a top-level comment notifies the other party but never the sender', async () => {
    const { taskId } = await makeClaimedTask();
    // Requester posts → the active claimant is notified; requester is not.
    const msg = await auth(http().post(`/api/tasks/${taskId}/messages`)).send({ body: 'hello team' });
    expect(msg.status).toBe(201);

    const toClaimer = (await notifs(claimer.userId, 'message.posted')).filter(
      (n) => (n.payload as any).taskId === taskId,
    );
    expect(toClaimer).toHaveLength(1);
    const toSelf = (await notifs(adminUserId, 'message.posted')).filter(
      (n) => (n.payload as any).taskId === taskId,
    );
    expect(toSelf).toHaveLength(0);
  });

  it('insertion is idempotent: re-emitting the same event_seq is a no-op', async () => {
    const svc = app.get(NotificationsService);
    const subjectId = (await prisma.task.findFirstOrThrow({ select: { id: true } })).id;
    const event = {
      organizationId: (await prisma.organization.findFirstOrThrow()).id,
      type: 'task.completed' as const,
      subjectType: 'idem-test',
      subjectId,
      senderUserId: adminUserId,
      recipientUserIds: [claimer.userId],
      payload: { taskId: subjectId },
      eventSeq: 7n,
    };
    const first = await prisma.$transaction((tx) => svc.emit(tx, event));
    const second = await prisma.$transaction((tx) => svc.emit(tx, event));
    expect(first).toEqual([claimer.userId]);
    expect(second).toEqual([claimer.userId]); // returns the cohort, but…
    const rows = await prisma.notification.findMany({
      where: { subjectType: 'idem-test', subjectId },
    });
    expect(rows).toHaveLength(1); // …only one row exists.
  });

  it('emitting pushes a sync ping through the PubSubPort to the recipient', async () => {
    const pubsub = app.get<PubSubPort>(PUBSUB_PORT);
    const pings: string[] = [];
    const unsub = pubsub.subscribe(adminUserId, (ev) => pings.push(ev.type));

    const { taskId } = await makeClaimedTask(); // claim → requester(admin) gets a ping
    expect(pings).toContain('sync');
    unsub();
    // After unsubscribe, no further pings land.
    const before = pings.length;
    await as(claimer.session)(http().post(`/api/tasks/${taskId}/leave`));
    expect(pings.length).toBe(before);
  });

  it('reconcile: GET /notifications lists rows unread-first with an accurate badge', async () => {
    const list = await as(claimer.session)(http().get('/api/notifications?limit=100'));
    expect(list.status).toBe(200);
    expect(list.body.unreadCount).toBeGreaterThan(0);
    expect(list.body.items.length).toBe(list.body.unreadCount); // all unread so far
    // Unread-first: the first item has no read_at.
    expect(list.body.items[0].readAt).toBeNull();
  });

  it('mark-read decrements the badge; read-all zeroes it', async () => {
    const before = await as(claimer.session)(http().get('/api/notifications?limit=100'));
    const firstId = before.body.items[0].id;
    const startUnread = before.body.unreadCount;
    expect(startUnread).toBeGreaterThan(0);

    const one = await as(claimer.session)(http().post(`/api/notifications/${firstId}/read`));
    expect(one.status).toBe(200);
    expect(one.body.unreadCount).toBe(startUnread - 1);

    const all = await as(claimer.session)(http().post('/api/notifications/read-all'));
    expect(all.status).toBe(200);
    expect(all.body.unreadCount).toBe(0);
  });

  it('the SSE stream serves text/event-stream and an initial sync ping', async () => {
    // The stream never ends, so read just the head with a short abort.
    const res = await new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const req = http()
        .get('/api/notifications/stream')
        .set('Cookie', claimer.session.cookies)
        .buffer(false)
        .parse((res, _cb) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('event: sync')) {
              resolve({ status: res.statusCode!, type: res.headers['content-type'] as string, body: data });
              (res as any).destroy();
            }
          });
        });
      req.end((err) => {
        // Aborting the stream surfaces as an error here — ignore once we've resolved.
        if (err && !/aborted|socket hang up|ECONNRESET/i.test(err.message)) reject(err);
      });
    });
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/event-stream');
    expect(res.body).toContain('event: sync');
  });
});
