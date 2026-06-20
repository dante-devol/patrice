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

/** Slice 4.1 — task schema + creation + questionnaire deep-copy + list + PATCH (#17). */
describe('Slice 4.1 — Tasks: creation, deep-copy, list, PATCH', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let artId: string;
  let emptyDivId: string; // a division with NO questionnaire
  let adminRoleId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    artId = (await auth(http().post('/api/divisions')).send({ name: 'Art' })).body.id;
    emptyDivId = (await auth(http().post('/api/divisions')).send({ name: 'Coordination' })).body.id;

    // Give Writing + Art a questionnaire (Coordination intentionally has none).
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [
        { type: 'text', prompt: 'Title', required: true, constraints: { maxChars: 120 } },
        { type: 'detail_text', prompt: 'Body', required: true, constraints: {} },
      ],
    });
    await auth(http().put(`/api/divisions/${artId}/questionnaire`)).send({
      questions: [{ type: 'attachment', prompt: 'Asset', required: true, constraints: { allowedTypes: ['image/png'] } }],
    });

    // The seeded Admin role isn't granted task:* by default — grant it globally.
    const adminUser = await prisma.appUser.findFirstOrThrow({
      where: { email: 'admin@example.com' },
      include: { userRoles: true },
    });
    adminRoleId = adminUser.userRoles[0].roleId;
    for (const action of ['task:create', 'task:update', 'task:retire']) {
      const g = await auth(http().post('/api/grants')).send({
        roleId: adminRoleId,
        action,
        scopeKind: 'global',
      });
      expect(g.status).toBe(201);
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('creates a task and deep-copies the division questionnaire', async () => {
    const res = await auth(http().post('/api/tasks')).send({
      name: 'First chapter',
      description: 'Write it',
      divisionId: writingId,
    });
    expect(res.status).toBe(201);
    expect(res.body.divisionId).toBe(writingId);
    expect(res.body.statusCache).toBe('open');
    expect(res.body.openings).toBe(1);
    const taskId = res.body.id;

    // The copy is a separate questionnaire row owned by the task (owner_task_id set,
    // owner_division_id null) — schema has no task.questionnaire_id.
    const qn = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    expect(qn.status).toBe(200);
    expect(qn.body.ownerTaskId).toBe(taskId);
    expect(qn.body.ownerDivisionId).toBeNull();
    expect(qn.body.questions.map((q: any) => q.prompt)).toEqual(['Title', 'Body']);

    // The copied questions are fresh rows (distinct ids from the division default).
    const divQn = await auth(http().get(`/api/divisions/${writingId}/questionnaire`));
    const divIds = new Set(divQn.body.questions.map((q: any) => q.id));
    for (const q of qn.body.questions) expect(divIds.has(q.id)).toBe(false);
  });

  it('editing the division default afterward does NOT change an existing task copy', async () => {
    const created = await auth(http().post('/api/tasks')).send({ name: 'Snapshot', divisionId: artId });
    const taskId = created.body.id;
    const before = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    expect(before.body.questions).toHaveLength(1);

    // Rewrite Art's default to a totally different set.
    await auth(http().put(`/api/divisions/${artId}/questionnaire`)).send({
      questions: [
        { type: 'text', prompt: 'New A', required: false, constraints: {} },
        { type: 'text', prompt: 'New B', required: false, constraints: {} },
      ],
    });

    const after = await auth(http().get(`/api/tasks/${taskId}/questionnaire`));
    expect(after.body.questions).toHaveLength(1);
    expect(after.body.questions[0].prompt).toBe('Asset');
  });

  it('422 NO_DEFAULT_QUESTIONNAIRE when the division has no questionnaire', async () => {
    const res = await auth(http().post('/api/tasks')).send({ name: 'Nope', divisionId: emptyDivId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_DEFAULT_QUESTIONNAIRE');
  });

  it('writes a task.created activity row with an IDs-only payload', async () => {
    const created = await auth(http().post('/api/tasks')).send({ name: 'Audited', divisionId: writingId });
    const row = await prisma.activity.findFirst({
      where: { verb: 'task.created', subjectId: created.body.id },
    });
    expect(row).not.toBeNull();
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.taskId).toBe(created.body.id);
    expect(payload.divisionId).toBe(writingId);
    expect(typeof payload.questionnaireId).toBe('string');
    expect(JSON.stringify(payload)).not.toContain('Audited');
  });

  describe('PATCH /tasks/:id — pure metadata only', () => {
    let taskId: string;
    beforeAll(async () => {
      taskId = (await auth(http().post('/api/tasks')).send({ name: 'Editable', divisionId: writingId })).body.id;
    });

    it('updates name and description', async () => {
      const res = await auth(http().patch(`/api/tasks/${taskId}`)).send({
        name: 'Renamed',
        description: 'New body',
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.description).toBe('New body');
      expect(res.body.version).toBeGreaterThan(0);
    });

    it('rejects a non-metadata field (422)', async () => {
      for (const bad of [{ openings: 5 }, { divisionId: artId }, { requesterUserId: taskId }, { claimsClosed: true }]) {
        const res = await auth(http().patch(`/api/tasks/${taskId}`)).send(bad as any);
        expect(res.status).toBe(422);
      }
    });
  });

  describe('GET /tasks — faceted filters + keyset pagination', () => {
    let pagingDivId: string;
    beforeAll(async () => {
      pagingDivId = (await auth(http().post('/api/divisions')).send({ name: 'Paging' })).body.id;
      await auth(http().put(`/api/divisions/${pagingDivId}/questionnaire`)).send({ questions: [] });
      for (let i = 0; i < 5; i++) {
        await auth(http().post('/api/tasks')).send({ name: `P${i}`, divisionId: pagingDivId });
      }
    });

    it('filters by division (index-backed facet)', async () => {
      const res = await auth(http().get(`/api/tasks?division=${pagingDivId}`));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(5);
      for (const t of res.body.items) expect(t.divisionId).toBe(pagingDivId);
    });

    it('keyset-paginates newest-first with a stable cursor', async () => {
      const page1 = await auth(http().get(`/api/tasks?division=${pagingDivId}&limit=2`));
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();
      // Newest-first: ids strictly descending.
      expect(page1.body.items[0].id > page1.body.items[1].id).toBe(true);

      const page2 = await auth(
        http().get(`/api/tasks?division=${pagingDivId}&limit=2&after=${page1.body.nextCursor}`),
      );
      expect(page2.body.items).toHaveLength(2);
      // No overlap between pages.
      const ids1 = new Set(page1.body.items.map((t: any) => t.id));
      for (const t of page2.body.items) expect(ids1.has(t.id)).toBe(false);
      expect(page2.body.items[0].id < page1.body.items[1].id).toBe(true);
    });

    it('supports in: multi-value facets', async () => {
      const res = await auth(http().get(`/api/tasks?division=in:${writingId},${pagingDivId}`));
      expect(res.status).toBe(200);
      const divs = new Set(res.body.items.map((t: any) => t.divisionId));
      expect(divs.has(writingId)).toBe(true);
      expect(divs.has(pagingDivId)).toBe(true);
    });

    it('filters by status', async () => {
      const res = await auth(http().get(`/api/tasks?status=open&division=${pagingDivId}`));
      expect(res.status).toBe(200);
      for (const t of res.body.items) expect(t.statusCache).toBe('open');
    });
  });

  describe('PUT /tasks/:id/questionnaire — task:configure_questionnaire', () => {
    let taskId: string;
    beforeAll(async () => {
      // Admin role also needs the configure action (not in the default seed).
      await auth(http().post('/api/grants')).send({
        roleId: adminRoleId,
        action: 'task:configure_questionnaire',
        scopeKind: 'global',
      });
      taskId = (await auth(http().post('/api/tasks')).send({ name: 'Configurable', divisionId: writingId })).body.id;
    });

    it('rewrites the task copy in place without touching the division default', async () => {
      const res = await auth(http().put(`/api/tasks/${taskId}/questionnaire`)).send({
        questions: [
          { type: 'text', prompt: 'Overridden A', required: false, constraints: {} },
          { type: 'numeric', prompt: 'Overridden B', required: true, constraints: { kind: 'integer', min: 0 } },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.ownerTaskId).toBe(taskId);
      expect(res.body.questions.map((q: any) => q.prompt)).toEqual(['Overridden A', 'Overridden B']);

      // The Writing default is unchanged (still Title/Body).
      const div = await auth(http().get(`/api/divisions/${writingId}/questionnaire`));
      expect(div.body.questions.map((q: any) => q.prompt)).toEqual(['Title', 'Body']);
    });

    it('writes a task_questionnaire.updated activity (IDs-only)', async () => {
      const row = await prisma.activity.findFirst({
        where: { verb: 'task_questionnaire.updated' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect((row!.payload as any).taskId).toBe(taskId);
    });
  });

  describe('Cedar — task:create scoping', () => {
    let scoped: AdminSession;
    beforeAll(async () => {
      const role = await auth(http().post('/api/roles')).send({ name: 'WritingCreator' });
      const roleId = role.body.id;
      await auth(http().post('/api/grants')).send({
        roleId,
        action: 'task:create',
        scopeKind: 'specific_division',
        scopeDivisionId: writingId,
      });
      const { session } = await inviteAndAccept(booted, admin, {
        email: 'wcreator@example.com',
        intendedRoleIds: [roleId],
      });
      scoped = session;
    });
    const asScoped = (r: request.Test) =>
      r.set('Cookie', scoped.cookies).set('x-csrf-token', scoped.csrf);

    it('a specific_division creator may create in their division', async () => {
      const res = await asScoped(http().post('/api/tasks')).send({ name: 'Scoped ok', divisionId: writingId });
      expect(res.status).toBe(201);
    });

    it('the same creator is refused in another division (403)', async () => {
      const res = await asScoped(http().post('/api/tasks')).send({ name: 'Scoped no', divisionId: artId });
      expect(res.status).toBe(403);
    });
  });
});
