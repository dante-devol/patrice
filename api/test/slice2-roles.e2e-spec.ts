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

/** Slice 2.1 — Roles CRUD + Revive (docs/slices/02; issue #8). */
describe('Slice 2.1 — Roles CRUD + Revive', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  let roleId: string;

  it('creates a standalone role; it appears in GET /roles', async () => {
    const res = await auth(http().post('/api/roles')).send({ name: 'WritingLead' });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('standalone');
    expect(res.body.lifecycleState).toBe('active');
    roleId = res.body.id;

    const list = await auth(http().get('/api/roles'));
    expect(list.status).toBe(200);
    expect(list.body.map((r: any) => r.name)).toContain('WritingLead');
  });

  it('PATCH /roles/:id updates the name', async () => {
    const res = await auth(http().patch(`/api/roles/${roleId}`)).send({
      name: 'WritingLeadRenamed',
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('WritingLeadRenamed');
  });

  it('PATCH with any non-metadata field → 422', async () => {
    const res = await auth(http().patch(`/api/roles/${roleId}`)).send({
      name: 'X',
      kind: 'division',
    });
    expect(res.status).toBe(422);
  });

  it('retire then revive within grace → role returns to active', async () => {
    const retire = await auth(http().post(`/api/roles/${roleId}/retire`));
    expect(retire.status).toBe(201);
    expect(retire.body.lifecycleState).toBe('retired');

    const revive = await auth(http().post(`/api/roles/${roleId}/revive`));
    expect(revive.status).toBe(201);
    expect(revive.body.lifecycleState).toBe('active');
    expect(revive.body.retiredAt).toBeNull();
  });

  it('revive a non-retired role → 409 NOT_REVIVABLE', async () => {
    const res = await auth(http().post(`/api/roles/${roleId}/revive`));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_REVIVABLE');
  });

  it('writes IDs-only activity rows for each transition', async () => {
    const prisma = new PrismaClient();
    try {
      const rows = await prisma.activity.findMany({
        where: { subjectType: 'role', subjectId: roleId },
        orderBy: { createdAt: 'asc' },
      });
      const verbs = rows.map((r) => r.verb);
      expect(verbs).toEqual(
        expect.arrayContaining([
          'role.created',
          'role.updated',
          'role.retired',
          'role.revived',
        ]),
      );
      // Payload Discipline: IDs only — no name/email/displayName keys.
      for (const r of rows) {
        expect(Object.keys(r.payload as object)).toEqual(['roleId']);
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('a non-admin (no grants) is denied POST /roles → 403', async () => {
    // Create a base user via invite, then attempt a role write.
    const inv = await auth(http().post('/api/invitations')).send({
      email: 'base-roles@example.com',
    });
    const token = inv.body.token as string;
    const accepted = await http().post(`/api/invite/${token}/accept`).send({
      email: 'base-roles@example.com',
      password: 'correct horse battery',
      displayName: 'Base',
    });
    const setCookie = accepted.headers['set-cookie'] as unknown as string[];
    const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
    const csrf = setCookie
      .map((c) => c.match(/patrice_csrf=([^;]+)/)?.[1])
      .find(Boolean)!;

    const res = await http()
      .post('/api/roles')
      .set('Cookie', cookies)
      .set('x-csrf-token', csrf)
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});
