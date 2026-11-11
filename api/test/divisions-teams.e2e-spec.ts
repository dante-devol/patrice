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

/** Divisions and teams, and membership in them (separate from roles). */
describe('Divisions, teams and membership', () => {
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
  let usaTeamId: string;
  let memberId: string;

  it('creating a division creates no role: membership is separate from authority', async () => {
    const rolesBefore = await prisma.role.count();
    const res = await auth(http().post('/api/divisions')).send({
      name: 'Writing',
      defaultOpenings: 3,
    });
    expect(res.status).toBe(201);
    writingId = res.body.id;
    expect(res.body.defaultOpenings).toBe(3);
    expect(await prisma.role.count()).toBe(rolesBefore);
  });

  it('a team belongs to a division', async () => {
    const missing = await auth(http().post('/api/teams')).send({ name: 'USA' });
    expect(missing.status).toBe(422);
    const res = await auth(http().post('/api/teams')).send({ name: 'USA', divisionIds: [writingId] });
    expect(res.status).toBe(201);
    expect(res.body.divisionIds).toEqual([writingId]);
    expect(res.body.allDivisions).toBe(false);
    usaTeamId = res.body.id;
  });

  it('PATCH edits the division', async () => {
    const res = await auth(http().patch(`/api/divisions/${writingId}`)).send({
      name: 'Writing & Editing',
      openingsLocked: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Writing & Editing');
    expect(res.body.openingsLocked).toBe(true);
  });

  it('members are added and removed explicitly, and grant nothing by themselves', async () => {
    const user = await prisma.appUser.create({ data: { email: 'm@example.com', displayName: 'M' } });
    memberId = user.id;
    const add = await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: memberId });
    expect(add.status).toBe(200);
    expect(add.body.map((m: { userId: string }) => m.userId)).toEqual([memberId]);
    // Idempotent.
    await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: memberId });
    expect(await prisma.membership.count({ where: { divisionId: writingId } })).toBe(1);
    expect(await prisma.userRole.count({ where: { userId: memberId } })).toBe(0);

    // Team membership doesn't imply division membership, and vice versa.
    await auth(http().post(`/api/teams/${usaTeamId}/members`)).send({ userId: memberId });
    const teamMembers = await auth(http().get(`/api/teams/${usaTeamId}/members`));
    expect(teamMembers.body).toHaveLength(1);

    const del = await auth(http().delete(`/api/divisions/${writingId}/members/${memberId}`));
    expect(del.status).toBe(204);
    expect(await prisma.membership.count({ where: { divisionId: writingId } })).toBe(0);
    expect(await prisma.membership.count({ where: { teamId: usaTeamId } })).toBe(1);
  });

  it('PATCH with a stale version → 409 STALE_VERSION and no change', async () => {
    const current = await prisma.division.findUniqueOrThrow({ where: { id: writingId } });
    const res = await auth(http().patch(`/api/divisions/${writingId}`)).send({
      restrictClaims: true,
      version: current.version - 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_VERSION');
    const after = await prisma.division.findUniqueOrThrow({ where: { id: writingId } });
    expect(after.version).toBe(current.version);
    expect(after.restrictClaims).toBe(current.restrictClaims);

    const ok = await auth(http().patch(`/api/divisions/${writingId}`)).send({
      restrictClaims: current.restrictClaims,
      version: current.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(current.version + 1);
  });

  it('division commands write their audit rows in the same transaction', async () => {
    const rows = await prisma.activity.findMany({
      where: { subjectId: writingId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.verb)).toEqual(
      expect.arrayContaining(['division.created', 'division.updated']),
    );
  });

  it('PATCH with a disallowed field → 422', async () => {
    const res = await auth(http().patch(`/api/divisions/${writingId}`)).send({
      lifecycleState: 'retired',
    });
    expect(res.status).toBe(422);
  });

  it('a retired division refuses edits and new members, and revives within grace', async () => {
    // USA's only division is Writing, so Writing can't be retired while USA is active.
    const blocked = await auth(http().post(`/api/divisions/${writingId}/retire`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DIVISION_SOLE_TEAM_DIVISION');
    expect(blocked.body.error.details.teams).toEqual([{ id: usaTeamId, name: 'USA' }]);
    expect((await auth(http().post(`/api/teams/${usaTeamId}/retire`))).status).toBe(201);

    const res = await auth(http().post(`/api/divisions/${writingId}/retire`));
    expect(res.status).toBe(201);
    expect(res.body.lifecycleState).toBe('retired');

    const edit = await auth(http().patch(`/api/divisions/${writingId}`)).send({ name: 'X' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('DIVISION_RETIRED');
    const add = await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: memberId });
    expect(add.status).toBe(409);

    const revive = await auth(http().post(`/api/divisions/${writingId}/revive`));
    expect(revive.status).toBe(201);
    expect(revive.body.lifecycleState).toBe('active');
    expect((await auth(http().post(`/api/teams/${usaTeamId}/revive`))).status).toBe(201);
  });

  it('restrict_claims is persisted on both division and team', async () => {
    const d = await auth(http().patch(`/api/divisions/${writingId}`)).send({
      restrictClaims: true,
    });
    expect(d.body.restrictClaims).toBe(true);
    const t = await auth(http().patch(`/api/teams/${usaTeamId}`)).send({
      restrictClaims: true,
    });
    expect(t.body.restrictClaims).toBe(true);
  });
});
