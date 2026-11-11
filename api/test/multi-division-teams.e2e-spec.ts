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

/**
 * Teams that serve more than one division (ADR 0020). Division authority, from a unit
 * role at the division or a division-scoped grant, reaches a team only while it lists
 * exactly that one division. Checked against USA[Writing], USA[Writing, Art], USA[all].
 */
describe('Multi-division teams', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let memberRoleId: string;
  let projectLeadId: string;
  let writingId: string;
  let artId: string;
  let codingId: string;
  let usaWriting: string;
  let usaWritingArt: string;
  let usaAll: string;

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession) => (r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin)(r);

  let n = 0;
  const newUser = async (roleIds: string[] = []) =>
    inviteAndAccept(booted, admin, { email: `mdt${++n}@example.com`, intendedRoleIds: [memberRoleId, ...roleIds] });
  const team = async (body: Record<string, unknown>, s: AdminSession = admin) =>
    as(s)(http().post('/api/teams')).send({ name: `Team ${++n}`, ...body });
  const createTask = (divisionId: string, teamId?: string) =>
    auth(http().post('/api/tasks')).send({
      name: `T${++n}`,
      divisionId,
      ...(teamId ? { teamId } : {}),
      template: { kind: 'default' },
    });

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    memberRoleId = (await prisma.systemSettings.findUniqueOrThrow({ where: { id: 1 } })).memberRoleId!;
    projectLeadId = (await prisma.role.findFirstOrThrow({ where: { name: 'Project lead' } })).id;
    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    artId = (await auth(http().post('/api/divisions')).send({ name: 'Art' })).body.id;
    codingId = (await auth(http().post('/api/divisions')).send({ name: 'Coding' })).body.id;
    for (const d of [writingId, artId, codingId]) {
      await auth(http().post(`/api/divisions/${d}/request-templates`)).send({
        name: 'Default',
        isDefault: true,
        questions: [{ type: 'detail_text', prompt: 'Body', required: true, constraints: {} }],
      });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  it('a team supports one division, several, or all of them', async () => {
    const one = await team({ divisionIds: [writingId] });
    expect(one.status).toBe(201);
    expect(one.body).toMatchObject({ divisionIds: [writingId], allDivisions: false });
    usaWriting = one.body.id;

    const two = await team({ divisionIds: [writingId, artId] });
    expect(two.status).toBe(201);
    expect([...two.body.divisionIds].sort()).toEqual([writingId, artId].sort());
    usaWritingArt = two.body.id;

    const all = await team({ allDivisions: true });
    expect(all.status).toBe(201);
    expect(all.body).toMatchObject({ divisionIds: [], allDivisions: true });
    usaAll = all.body.id;
  });

  it('refuses a team with no divisions, or with both a list and all divisions', async () => {
    expect((await team({})).status).toBe(422);
    expect((await team({ divisionIds: [] })).status).toBe(422);
    expect((await team({ divisionIds: [writingId], allDivisions: true })).status).toBe(422);
  });

  it('a task may use any team that supports its division', async () => {
    expect((await createTask(artId, usaWritingArt)).status).toBe(201);
    expect((await createTask(codingId, usaAll)).status).toBe(201);
    const wrong = await createTask(artId, usaWriting);
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('TEAM_NOT_IN_DIVISION');
  });

  describe.each([
    ['a Project lead at Writing (unit role)', 'unit'],
    ['a Writing division-scoped grant', 'grant'],
  ])('%s', (_label, kind) => {
    let lead: AdminSession;

    beforeAll(async () => {
      if (kind === 'unit') {
        const u = await newUser();
        await auth(http().post(`/api/divisions/${writingId}/role-assignments`)).send({
          userId: u.userId,
          roleId: projectLeadId,
        });
        lead = u.session;
      } else {
        const role = (await auth(http().post('/api/roles')).send({ name: `Writing team admin ${++n}` })).body.id;
        for (const action of ['team:create', 'team:update']) {
          const g = await auth(http().post('/api/grants')).send({
            roleId: role,
            action,
            effect: 'permit',
            scopeKind: 'specific_division',
            scopeDivisionId: writingId,
          });
          expect(g.status).toBe(201);
        }
        lead = (await newUser([role])).session;
      }
    });

    const rename = (id: string) => as(lead)(http().patch(`/api/teams/${id}`)).send({ name: `Renamed ${++n}` });

    it('edits USA[Writing], but not USA[Writing, Art] or USA[all]', async () => {
      expect((await rename(usaWriting)).status).toBe(200);
      expect((await rename(usaWritingArt)).status).toBe(403);
      expect((await rename(usaAll)).status).toBe(403);
    });

    it('creates Writing-only teams, but not wider ones', async () => {
      expect((await team({ divisionIds: [writingId] }, lead)).status).toBe(201);
      expect((await team({ divisionIds: [writingId, artId] }, lead)).status).toBe(403);
      expect((await team({ allDivisions: true }, lead)).status).toBe(403);
      expect((await team({ divisionIds: [artId] }, lead)).status).toBe(403);
    });

    it("can't widen a team beyond Writing, or take over a wider team by narrowing it", async () => {
      const widen = await as(lead)(http().patch(`/api/teams/${usaWriting}`)).send({ divisionIds: [writingId, artId] });
      expect(widen.status).toBe(403);
      const narrow = await as(lead)(http().patch(`/api/teams/${usaWritingArt}`)).send({ divisionIds: [writingId] });
      expect(narrow.status).toBe(403);
      const team = await prisma.team.findUniqueOrThrow({ where: { id: usaWriting }, include: { divisions: true } });
      expect(team.divisions.map((d) => d.divisionId)).toEqual([writingId]);
    });
  });

  it("dropping a division the team's tasks use is refused, with counts", async () => {
    // usaWritingArt has an Art task (above).
    const res = await auth(http().patch(`/api/teams/${usaWritingArt}`)).send({ divisionIds: [writingId] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEAM_DIVISION_IN_USE');
    expect(res.body.error.details.divisions).toEqual([{ divisionId: artId, tasks: 1 }]);
    // Switching off all divisions counts too: usaAll has a Coding task.
    const off = await auth(http().patch(`/api/teams/${usaAll}`)).send({ allDivisions: false, divisionIds: [writingId] });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('TEAM_DIVISION_IN_USE');
  });

  it('widening a team is recorded, divisions and all', async () => {
    const res = await auth(http().patch(`/api/teams/${usaWritingArt}`)).send({ divisionIds: [writingId, artId, codingId] });
    expect(res.status).toBe(200);
    expect(res.body.divisionIds).toHaveLength(3);
    const row = await prisma.activity.findFirstOrThrow({
      where: { subjectId: usaWritingArt, verb: 'team.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect((row.payload as { changes: { divisions: { to: string[] } } }).changes.divisions.to).toHaveLength(3);
  });

  it("a division's stats list every team that supports it", async () => {
    const res = await auth(http().get(`/api/divisions/${artId}/stats`));
    expect(res.status).toBe(200);
    const ids = res.body.teams.map((t: { teamId: string }) => t.teamId);
    expect(ids).toEqual(expect.arrayContaining([usaWritingArt, usaAll]));
    expect(ids).not.toContain(usaWriting);
    const wa = res.body.teams.find((t: { teamId: string }) => t.teamId === usaWritingArt);
    expect(wa.open).toBe(1); // its Art task only
  });

  it('retiring a division is refused while it is some active team’s only active division', async () => {
    const artOnly = (await team({ divisionIds: [artId] })).body.id;
    const refused = await auth(http().post(`/api/divisions/${artId}/retire`));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DIVISION_SOLE_TEAM_DIVISION');
    // Only the Art-only team blocks: the multi-division and all-division teams don't.
    expect(refused.body.error.details.teams.map((t: { id: string }) => t.id)).toEqual([artOnly]);

    expect((await auth(http().post(`/api/teams/${artOnly}/retire`))).status).toBe(201);
    const ok = await auth(http().post(`/api/divisions/${artId}/retire`));
    expect(ok.status).toBe(201);

    // A team may keep listing a retired division; it can't newly add one.
    const add = await auth(http().patch(`/api/teams/${usaWriting}`)).send({ divisionIds: [writingId, artId] });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('DIVISION_RETIRED');
    expect((await auth(http().post(`/api/divisions/${artId}/revive`))).status).toBe(201);
  });

});
