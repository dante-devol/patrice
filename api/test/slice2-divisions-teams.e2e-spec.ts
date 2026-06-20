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

/** Slice 2.2 — Divisions + Teams with inherent-role auto-creation (issue #9). */
describe('Slice 2.2 — Divisions + Teams', () => {
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
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  let writingId: string;
  let writingRoleId: string;
  let usaTeamId: string;

  it('creating a division auto-creates its inherent role (kind=division, same name)', async () => {
    const res = await auth(http().post('/divisions')).send({
      name: 'Writing',
      defaultOpenings: 3,
    });
    expect(res.status).toBe(201);
    writingId = res.body.id;
    writingRoleId = res.body.inherentRoleId;
    expect(res.body.defaultOpenings).toBe(3);

    const role = await prisma.role.findUnique({ where: { id: writingRoleId } });
    expect(role?.kind).toBe('division');
    expect(role?.divisionId).toBe(writingId);
    expect(role?.name).toBe('Writing');
  });

  it('creating a team auto-creates its inherent role (kind=team)', async () => {
    const res = await auth(http().post('/teams')).send({ name: 'USA' });
    expect(res.status).toBe(201);
    usaTeamId = res.body.id;
    const role = await prisma.role.findUnique({
      where: { id: res.body.inherentRoleId },
    });
    expect(role?.kind).toBe('team');
    expect(role?.teamId).toBe(usaTeamId);
  });

  it('PATCH renames the division and its inherent role in lock-step', async () => {
    const res = await auth(http().patch(`/divisions/${writingId}`)).send({
      name: 'Writing & Editing',
      openingsLocked: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.openingsLocked).toBe(true);
    const role = await prisma.role.findUnique({ where: { id: writingRoleId } });
    expect(role?.name).toBe('Writing & Editing');
  });

  it('PATCH with a disallowed field → 422', async () => {
    const res = await auth(http().patch(`/divisions/${writingId}`)).send({
      lifecycleState: 'retired',
    });
    expect(res.status).toBe(422);
  });

  it('retiring a division retires its inherent role in the same transaction', async () => {
    const res = await auth(http().post(`/divisions/${writingId}/retire`));
    expect(res.status).toBe(201);
    expect(res.body.lifecycleState).toBe('retired');
    const role = await prisma.role.findUnique({ where: { id: writingRoleId } });
    expect(role?.lifecycleState).toBe('retired');
  });

  it('reviving the division within grace revives both it and its inherent role', async () => {
    const res = await auth(http().post(`/divisions/${writingId}/revive`));
    expect(res.status).toBe(201);
    expect(res.body.lifecycleState).toBe('active');
    const role = await prisma.role.findUnique({ where: { id: writingRoleId } });
    expect(role?.lifecycleState).toBe('active');
    expect(role?.retiredAt).toBeNull();
  });

  it('the inherent role cannot be lifecycle-edited directly via /roles → 422', async () => {
    const res = await auth(http().post(`/roles/${writingRoleId}/retire`));
    expect(res.status).toBe(422);
  });

  it('restrict_claims is persisted on both division and team', async () => {
    const d = await auth(http().patch(`/divisions/${writingId}`)).send({
      restrictClaims: true,
    });
    expect(d.body.restrictClaims).toBe(true);
    const t = await auth(http().patch(`/teams/${usaTeamId}`)).send({
      restrictClaims: true,
    });
    expect(t.body.restrictClaims).toBe(true);
  });
});
