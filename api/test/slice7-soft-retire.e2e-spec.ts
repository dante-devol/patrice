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
  resetDatabase,
} from './helpers';

/**
 * Slice 7.2 — soft-retire default filter + Grace Period from org settings +
 * Retired-as-Hard-Deny exercised for real (#29).
 */
describe('Slice 7.2 — Soft-retire filter, grace config, hard-deny', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    // Grant the admin role the task lifecycle actions used below.
    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    const roleId = adminUser.userRoles[0].roleId;
    for (const action of ['task:create']) {
      await auth(http().post('/api/grants')).send({ roleId, action, scopeKind: 'global' });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('default list excludes retired entities; ?include=retired returns them', async () => {
    const keep = (await auth(http().post('/api/divisions')).send({ name: 'Keep' })).body.id;
    const gone = (await auth(http().post('/api/divisions')).send({ name: 'Gone' })).body.id;
    await auth(http().post(`/api/divisions/${gone}/retire`));

    const def = await auth(http().get('/api/divisions'));
    const defIds = def.body.map((d: any) => d.id);
    expect(defIds).toContain(keep);
    expect(defIds).not.toContain(gone);

    const all = await auth(http().get('/api/divisions?include=retired'));
    const allIds = all.body.map((d: any) => d.id);
    expect(allIds).toContain(keep);
    expect(allIds).toContain(gone);
  });

  it('Grace Period is read from organization.settings (gracePeriodHours)', async () => {
    const div = (await auth(http().post('/api/divisions')).send({ name: 'Grace' })).body.id;

    // Zero-length grace window: a just-retired entity is already past grace.
    const cfg = await auth(http().patch('/api/config')).send({ gracePeriodHours: 0 });
    expect(cfg.status).toBe(200);
    expect(cfg.body.gracePeriodHours).toBe(0);

    await auth(http().post(`/api/divisions/${div}/retire`));
    const revive = await auth(http().post(`/api/divisions/${div}/revive`));
    expect(revive.status).toBe(409);
    expect(revive.body.error.code).toBe('NOT_REVIVABLE');

    // Restore a generous window and confirm revive then succeeds.
    await auth(http().patch('/api/config')).send({ gracePeriodHours: 24 });
    const revive2 = await auth(http().post(`/api/divisions/${div}/revive`));
    expect(revive2.status).toBe(201);
    expect(revive2.body.lifecycleState).toBe('active');
  });

  it('blocks creating a new reference to a retired entity (API layer)', async () => {
    const div = (await auth(http().post('/api/divisions')).send({ name: 'Retired Div' })).body.id;
    await auth(http().put(`/api/divisions/${div}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Q', required: false, constraints: {} }],
    });
    await auth(http().post(`/api/divisions/${div}/retire`));

    const res = await auth(http().post('/api/tasks')).send({ name: 'T', divisionId: div });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DIVISION_RETIRED');
  });

  it('Retired-as-Hard-Deny: a gated mutation on a retired division returns 403', async () => {
    const div = (await auth(http().post('/api/divisions')).send({ name: 'Deny Div' })).body.id;
    await auth(http().post(`/api/divisions/${div}/retire`));
    // division:update is gated against the Division resource (carries retired=true),
    // so the static forbid fires regardless of the admin's global grant.
    const res = await auth(http().patch(`/api/divisions/${div}`)).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});
