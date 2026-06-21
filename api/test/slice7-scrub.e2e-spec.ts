/* eslint-disable */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/** Slice 7.4 — user Scrub-in-Place, invitation auto-revoke, anonymizeLabel (#31). */
describe('Slice 7.4 — User scrub-in-place', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let orgId: string;
  let taskId: string;

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
    orgId = adminUser.organizationId;
    for (const action of ['task:create']) {
      await auth(http().post('/api/grants')).send({
        roleId: adminUser.userRoles[0].roleId,
        action,
        scopeKind: 'global',
      });
    }

    const writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Q', required: false, constraints: {} }],
    });
    taskId = (
      await auth(http().post('/api/tasks')).send({ name: 'Host', divisionId: writingId })
    ).body.id;

    await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('scrubs a history-bearing user to a tombstone; revokes their invites; nulls received email', async () => {
    const { userId } = await inviteAndAccept(booted, admin, { email: 'hist@example.com' });

    // Give the user authored history (a message) so they scrub rather than delete.
    await prisma.message.create({
      data: { taskId, kind: 'comment', senderUserId: userId, body: 'authored' },
    });
    // A pending invitation this user issued — must be auto-revoked on scrub.
    const issued = await prisma.invitation.create({
      data: {
        organizationId: orgId,
        tokenHash: randomUUID(),
        email: 'pending@example.com',
        createdBy: userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    // The invitation this user *received* still carries their email.
    const received = await prisma.invitationUse.findFirstOrThrow({
      where: { createdUserId: userId },
    });

    const retire = await auth(http().post(`/api/users/${userId}/retire`));
    expect(retire.status).toBe(204);

    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.usersScrubbed).toContain(userId);

    // Tombstone: row + display_name kept, email/PII + satellites gone.
    const stub = await prisma.appUser.findUnique({ where: { id: userId } });
    expect(stub).not.toBeNull();
    expect(stub!.displayName).toBe('hist');
    expect(stub!.email).toBeNull();
    expect(stub!.lifecycleState).toBe('retired');
    expect(await prisma.userIdentity.count({ where: { userId } })).toBe(0);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    expect(await prisma.userRole.count({ where: { userId } })).toBe(0);

    // The authored message still resolves to the tombstone (FK preserved).
    const msg = await prisma.message.findFirst({ where: { senderUserId: userId } });
    expect(msg).not.toBeNull();

    // Invites issued → revoked (+ audit); invite received → email nulled.
    expect((await prisma.invitation.findUnique({ where: { id: issued.id } }))!.revokedAt).not.toBeNull();
    expect((await prisma.invitation.findUnique({ where: { id: received.invitationId } }))!.email).toBeNull();
    expect(
      await prisma.activity.count({
        where: { subjectId: issued.id, verb: 'invite.auto_revoked_on_issuer_retired' },
      }),
    ).toBe(1);
    expect(
      await prisma.activity.count({ where: { subjectId: userId, verb: 'gc.user_scrubbed' } }),
    ).toBe(1);
  });

  it('fully deletes a history-less user', async () => {
    const { userId } = await inviteAndAccept(booted, admin, { email: 'bare@example.com' });
    await auth(http().post(`/api/users/${userId}/retire`));

    const sweep = await auth(http().post('/api/gc/sweep'));
    expect(sweep.body.usersDeleted).toContain(userId);
    expect(await prisma.appUser.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('anonymizeLabel renders scrubbed users as "Former member"', async () => {
    await auth(http().patch('/api/config')).send({ anonymizeLabel: true });
    const list = await auth(http().get('/api/users?include=retired'));
    const scrubbed = list.body.find((u: any) => u.displayName === 'Former member');
    expect(scrubbed).toBeDefined();
    expect(scrubbed.lifecycleState).toBe('retired');
  });
});
