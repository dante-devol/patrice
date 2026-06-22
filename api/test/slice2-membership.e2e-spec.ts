import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AccessService } from '../src/access/access.service';
import { GrantsService } from '../src/grants/grants.service';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/** Slice 2.4 — Membership, administrability invariant, org settings (issue #11). */
describe('Slice 2.4 — Membership + administrability + config', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let access: AccessService;

  let adminUserId: string;
  let leadRoleId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    access = app.get(AccessService);

    const me = await http().get('/api/me').set('Cookie', admin.cookies);
    adminUserId = me.body.id;
    const lead = await auth(http().post('/api/roles')).send({ name: 'WritingLead' });
    leadRoleId = lead.body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('admin grants a role to a user (membership)', async () => {
    const { userId } = await inviteAndAccept(booted, admin, {
      email: 'member@example.com',
    });
    const res = await auth(http().post(`/api/users/${userId}/roles`)).send({
      roleId: leadRoleId,
    });
    expect(res.status).toBe(204);
    const ur = await prisma.userRole.findFirst({
      where: { userId, roleId: leadRoleId },
    });
    expect(ur).toBeTruthy();

    // Revoke it again.
    const del = await auth(http().delete(`/api/users/${userId}/roles/${leadRoleId}`));
    expect(del.status).toBe(204);
  });

  it('grant is refused when the granted role exceeds the actor’s grantable set (403)', async () => {
    // A delegated user with user:grant_role scoped to ONLY leadRole.
    const delegateRole = await auth(http().post('/api/roles')).send({ name: 'Delegate' });
    const delegateRoleId = delegateRole.body.id;
    await auth(http().post('/api/grants')).send({
      roleId: delegateRoleId,
      action: 'user:grant_role',
      scopeKind: 'role',
      scopeRoleId: leadRoleId,
    });
    const otherRole = await auth(http().post('/api/roles')).send({ name: 'OtherRole' });

    const { userId: delegateUserId, session: delegateSession } =
      await inviteAndAccept(booted, admin, {
        email: 'delegate@example.com',
        intendedRoleIds: [delegateRoleId],
      });
    const { userId: targetId } = await inviteAndAccept(booted, admin, {
      email: 'target@example.com',
    });

    // The delegate may grant leadRole…
    const ok = await http()
      .post(`/api/users/${targetId}/roles`)
      .set('Cookie', delegateSession.cookies)
      .set('x-csrf-token', delegateSession.csrf)
      .send({ roleId: leadRoleId });
    expect(ok.status).toBe(204);

    // …but NOT otherRole (outside its grantable set).
    const denied = await http()
      .post(`/api/users/${targetId}/roles`)
      .set('Cookie', delegateSession.cookies)
      .set('x-csrf-token', delegateSession.csrf)
      .send({ roleId: otherRole.body.id });
    expect(denied.status).toBe(403);
  });

  it('invite creation cannot pre-assign a role the issuer may not grant (H1 escalation guard)', async () => {
    // An issuer who may create invites and grant ONLY leadRole.
    const issuerRole = await auth(http().post('/api/roles')).send({ name: 'InviterLtd' });
    const issuerRoleId = issuerRole.body.id;
    await auth(http().post('/api/grants')).send({
      roleId: issuerRoleId,
      action: 'invite:create',
      scopeKind: 'global',
    });
    await auth(http().post('/api/grants')).send({
      roleId: issuerRoleId,
      action: 'user:grant_role',
      scopeKind: 'role',
      scopeRoleId: leadRoleId,
    });
    const privileged = await auth(http().post('/api/roles')).send({ name: 'Privileged' });

    const { session: issuer } = await inviteAndAccept(booted, admin, {
      email: 'issuer@example.com',
      intendedRoleIds: [issuerRoleId],
    });
    const issued = (r: request.Test) =>
      r.set('Cookie', issuer.cookies).set('x-csrf-token', issuer.csrf);

    // Pre-assigning the in-scope role is allowed…
    const ok = await issued(http().post('/api/invitations')).send({
      email: 'invitee-ok@example.com',
      intendedRoleIds: [leadRoleId],
    });
    expect(ok.status).toBe(201);

    // …pre-assigning a role outside the issuer's grantable set is refused at creation,
    // closing the invite-as-privilege-escalation path (the direct grant_role path is
    // already gated; the invite path used to skip the check entirely).
    const escalate = await issued(http().post('/api/invitations')).send({
      email: 'invitee-bad@example.com',
      intendedRoleIds: [privileged.body.id],
    });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.code).toBe('ROLE_NOT_GRANTABLE');
  });

  describe('administrability invariant (real)', () => {
    it('revoking the last admin’s Admin role is refused with 409 LAST_ADMIN + activity', async () => {
      const adminRole = await prisma.role.findFirstOrThrow({
        where: { name: 'Admin', kind: 'standalone' },
        select: { id: true },
      });
      const res = await auth(
        http().delete(`/api/users/${adminUserId}/roles/${adminRole.id}`),
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');

      const refusal = await prisma.activity.findFirst({
        where: { verb: 'last_admin_refused' },
      });
      expect(refusal).toBeTruthy();

      // The admin still holds the role (rolled back).
      const ur = await prisma.userRole.findFirst({
        where: { userId: adminUserId, roleId: adminRole.id },
      });
      expect(ur).toBeTruthy();
    });

    it('deactivating the last admin is refused with 409 LAST_ADMIN', async () => {
      const res = await auth(http().post(`/api/users/${adminUserId}/deactivate`));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    });

    it('retiring the Admin role is refused with 409 LAST_ADMIN', async () => {
      const adminRole = await prisma.role.findFirstOrThrow({
        where: { name: 'Admin', kind: 'standalone' },
        select: { id: true },
      });
      const res = await auth(http().post(`/api/roles/${adminRole.id}/retire`));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_ADMIN');
    });

    it('retiring the LAST governance grant is refused with 409 LAST_ADMIN', async () => {
      // Retiring grant:retire through the API would remove the actor's own retire
      // authority mid-way (a correct 403), so this path is exercised against the
      // service directly — isolating the admin-floor guard from the AuthorizeGuard.
      const govActions = [
        'grant:create',
        'grant:update',
        'grant:retire',
        'role:create',
        'role:update',
        'role:retire',
      ];
      const rows = await prisma.grant.findMany({
        where: {
          action: { in: govActions },
          scopeKind: 'global',
          lifecycleState: 'active',
        },
        select: { id: true },
      });
      expect(rows.length).toBe(6);

      const svc = app.get(GrantsService);
      for (let i = 0; i < rows.length - 1; i++) {
        await svc.retire(rows[i].id, adminUserId);
      }
      await expect(
        svc.retire(rows[rows.length - 1].id, adminUserId),
      ).rejects.toMatchObject({ response: { error: { code: 'LAST_ADMIN' } } });

      // The last governance grant survived the rollback; restore the others.
      for (let i = 0; i < rows.length - 1; i++) {
        await svc.revive(rows[i].id, adminUserId);
      }

      const refusal = await prisma.activity.findFirst({
        where: { verb: 'last_admin_refused', subjectType: 'grant' },
      });
      expect(refusal).toBeTruthy();
    });
  });

  describe('organization.settings editor', () => {
    it('GET /config returns defaults', async () => {
      const res = await auth(http().get('/api/config'));
      expect(res.status).toBe(200);
      expect(res.body.selfReviewAllowed).toBe(false);
      expect(res.body.sessionAbsoluteDays).toBe(30);
    });

    it('PATCH selfReviewAllowed patches the Cedar policy set + bumps config_version', async () => {
      // Seed a task:review grant + a requester-owned task so the self-review
      // forbid is observable: with selfReviewAllowed=false the requester is denied
      // reviewing their own task; flipping to true permits it.
      const reviewerRole = await auth(http().post('/api/roles')).send({
        name: 'Reviewer',
      });
      await auth(http().post('/api/grants')).send({
        roleId: reviewerRole.body.id,
        action: 'task:review',
        scopeKind: 'global',
      });
      const { userId } = await inviteAndAccept(booted, admin, {
        email: 'reviewer@example.com',
        intendedRoleIds: [reviewerRole.body.id],
      });

      // Self-review = reviewing a submission you AUTHORED, so the forbid keys off the
      // reviewed submission's `claimant` (Slice 5), not the requester. This task carries
      // the reviewer as the claimant of the submission under review.
      const ownTask = {
        type: 'Task' as const,
        id: '00000000-0000-7000-8000-000000000001',
        attrs: {
          requester: { __entity: { type: 'Patrice::User', id: userId } },
          claimant: { __entity: { type: 'Patrice::User', id: userId } },
          retired: false,
        },
      };

      const before = await prisma.organization.findFirstOrThrow({
        select: { configVersion: true },
      });
      // Control: the reviewer CAN review a task owned by someone else (the global
      // permit is in place) — isolates the self-review forbid from a missing permit.
      const othersTask = {
        type: 'Task' as const,
        id: '00000000-0000-7000-8000-000000000002',
        attrs: {
          requester: { __entity: { type: 'Patrice::User', id: userId } },
          claimant: { __entity: { type: 'Patrice::User', id: adminUserId } },
          retired: false,
        },
      };
      expect(
        await access.decide({ userId, action: 'task:review', resource: othersTask }),
      ).toBe(true);
      // selfReviewAllowed defaults false → forbid active → denied on own task.
      expect(
        await access.decide({ userId, action: 'task:review', resource: ownTask }),
      ).toBe(false);

      const patch = await auth(http().patch('/api/config')).send({
        selfReviewAllowed: true,
      });
      expect(patch.status).toBe(200);
      expect(patch.body.selfReviewAllowed).toBe(true);

      const after = await prisma.organization.findFirstOrThrow({
        select: { configVersion: true },
      });
      expect(after.configVersion > before.configVersion).toBe(true);

      // Forbid lifted → now permitted to review own task.
      expect(
        await access.decide({ userId, action: 'task:review', resource: ownTask }),
      ).toBe(true);
    });

    it('flipping requireVerifiedEmailToLogIn does NOT invalidate existing sessions', async () => {
      await auth(http().patch('/api/config')).send({
        requireVerifiedEmailToLogIn: true,
      });
      const me = await http().get('/api/me').set('Cookie', admin.cookies);
      expect(me.status).toBe(200); // admin's existing session still valid
    });

    it('PATCH /config rejects an unknown field with 422', async () => {
      const res = await auth(http().patch('/api/config')).send({ bogus: true });
      expect(res.status).toBe(422);
    });
  });
});
