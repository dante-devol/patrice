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
 * Request template library and custom templates (redesign plan §3): a division keeps
 * several templates, a requester picks one (or the default), and custom questions are
 * open where the division allows them or a grant says so.
 */
describe('Request template library', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let memberRoleId: string;
  let writingId: string;
  let artId: string;
  let member: { userId: string; session: AdminSession };

  const http = () => request(app.getHttpServer());
  const as = (s: AdminSession, r: request.Test) => r.set('Cookie', s.cookies).set('x-csrf-token', s.csrf);
  const auth = (r: request.Test) => as(admin, r);

  const allSevenTypes = [
    { type: 'detail_text', prompt: 'Your writing', required: true, constraints: { maxChars: 5000 } },
    { type: 'multiline', prompt: 'Notes', required: false, constraints: {} },
    { type: 'text', prompt: 'Title', required: true, constraints: { minChars: 1, maxChars: 120 } },
    { type: 'numeric', prompt: 'Rating', required: true, constraints: { kind: 'integer', min: 1, max: 10 } },
    { type: 'dropdown', prompt: 'Category', required: false, constraints: { multi: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
    { type: 'radio', prompt: 'Priority', required: true, constraints: { multi: false, options: [{ value: 'lo', label: 'Low' }, { value: 'hi', label: 'High' }] } },
    { type: 'attachment', prompt: 'Asset', required: true, constraints: { allowedTypes: ['image/png', 'image/jpeg'], maxFiles: 3 } },
  ];
  const text = (prompt: string) => ({ type: 'text', prompt, required: false, constraints: {} });

  async function createTemplate(divisionId: string, body: Record<string, unknown>) {
    const res = await auth(http().post(`/api/divisions/${divisionId}/request-templates`)).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number; questions: { id: string; prompt: string }[] };
  }

  beforeAll(async () => {
    await resetDatabase();
    booted = await bootApp({ emailStub: createEmailCapture().stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    memberRoleId = (await prisma.systemSettings.findFirstOrThrow()).memberRoleId!;
    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    artId = (await auth(http().post('/api/divisions')).send({ name: 'Art' })).body.id;
    member = await inviteAndAccept(booted, admin, { email: 'member@example.com', intendedRoleIds: [memberRoleId] });
    await auth(http().post(`/api/divisions/${writingId}/members`)).send({ userId: member.userId });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  describe('managing the library', () => {
    it('a new division has an empty library', async () => {
      const res = await auth(http().get(`/api/divisions/${writingId}/request-templates`));
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('round-trips all seven question types with their constraints', async () => {
      const t = await createTemplate(writingId, { name: 'Full', isDefault: true, questions: allSevenTypes });
      const get = await auth(http().get(`/api/request-templates/${t.id}`));
      expect(get.status).toBe(200);
      expect(get.body).toMatchObject({ divisionId: writingId, name: 'Full', isDefault: true, version: 0 });
      expect(get.body.questions.map((q: { type: string }) => q.type)).toEqual(allSevenTypes.map((q) => q.type));
      expect(get.body.questions.map((q: { ordinal: number }) => q.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(get.body.questions[3].constraints).toEqual({ kind: 'integer', min: 1, max: 10 });
    });

    it('holds several templates, default first, with question counts', async () => {
      await createTemplate(writingId, { name: 'Coordination only', questions: [] });
      const list = await auth(http().get(`/api/divisions/${writingId}/request-templates`));
      expect(list.body.items.map((t: { name: string }) => t.name)).toEqual(['Full', 'Coordination only']);
      expect(list.body.items.map((t: { questionCount: number }) => t.questionCount)).toEqual([7, 0]);
    });

    it('making another template the default moves the default', async () => {
      const brief = await createTemplate(writingId, { name: 'Brief', isDefault: true, questions: [text('Gist')] });
      const list = await auth(http().get(`/api/divisions/${writingId}/request-templates`));
      expect(list.body.items.filter((t: { isDefault: boolean }) => t.isDefault).map((t: { id: string }) => t.id)).toEqual([
        brief.id,
      ]);
    });

    it('the database allows one default per division', async () => {
      await expect(
        prisma.requestTemplate.create({ data: { divisionId: writingId, name: 'Sneaky', isDefault: true } }),
      ).rejects.toThrow();
    });

    it('names are unique per division, ignoring case', async () => {
      const dup = await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({ name: 'brief', questions: [] });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('TEMPLATE_NAME_TAKEN');
      // Another division may reuse it.
      await createTemplate(artId, { name: 'Brief', questions: [] });
    });

    it('rejects constraints that do not fit the question type', async () => {
      const bad = await auth(http().post(`/api/divisions/${writingId}/request-templates`)).send({
        name: 'Bad',
        questions: [{ type: 'text', prompt: 'Bad', constraints: { kind: 'integer', min: 1 } }],
      });
      expect(bad.status).toBe(422);
    });

    it('an edit diffs questions by id: kept ids survive, reordering works, missing ones go', async () => {
      const t = await createTemplate(writingId, { name: 'Diffed', questions: [text('A'), text('B'), text('C')] });
      const [a, b] = t.questions;
      const res = await auth(http().patch(`/api/request-templates/${t.id}`)).send({
        version: t.version,
        questions: [{ ...text('B, edited'), id: b.id }, { ...text('A'), id: a.id }, text('D')],
      });
      expect(res.status).toBe(200);
      expect(res.body.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['B, edited', 'A', 'D']);
      expect(res.body.questions[0].id).toBe(b.id);
      expect(res.body.questions[1].id).toBe(a.id);
      expect(res.body.version).toBe(t.version + 1);

      const row = await prisma.activity.findFirst({
        where: { verb: 'request_template.updated', subjectId: t.id },
        orderBy: { createdAt: 'desc' },
      });
      const payload = row!.payload as { questions: { removed: string[]; changed: string[] } };
      expect(payload.questions.removed).toEqual([t.questions[2].id]);
      // Prompts are user text: recorded by id only.
      expect(JSON.stringify(payload)).not.toContain('edited');
    });

    it('a stale version is refused, and an unknown question id is a 422', async () => {
      const t = await createTemplate(writingId, { name: 'Versioned', questions: [text('Q')] });
      const stale = await auth(http().patch(`/api/request-templates/${t.id}`)).send({ version: t.version + 5, name: 'X' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');
      const foreign = await auth(http().patch(`/api/request-templates/${t.id}`)).send({
        version: t.version,
        questions: [{ ...text('Q'), id: '00000000-0000-7000-8000-000000000000' }],
      });
      expect(foreign.status).toBe(422);
      expect(foreign.body.error.code).toBe('UNKNOWN_QUESTION_ID');
    });

    it('editing or deleting a library template leaves existing tasks unchanged', async () => {
      const t = await createTemplate(writingId, { name: 'Doomed', questions: [text('Original')] });
      const task = await auth(http().post('/api/tasks')).send({
        name: 'Uses it',
        divisionId: writingId,
        template: { kind: 'library', templateId: t.id },
      });
      expect(task.status).toBe(201);
      expect(task.body.sourceTemplateId).toBe(t.id);

      await auth(http().patch(`/api/request-templates/${t.id}`)).send({ version: t.version, questions: [text('Changed')] });
      expect((await auth(http().delete(`/api/request-templates/${t.id}`))).status).toBe(204);
      expect((await auth(http().get(`/api/request-templates/${t.id}`))).status).toBe(404);

      const snapshot = await auth(http().get(`/api/tasks/${task.body.id}/request-template`));
      expect(snapshot.body.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['Original']);
      expect(snapshot.body.sourceTemplateId).toBeNull();
      const audit = await prisma.activity.findFirst({ where: { verb: 'request_template.deleted', subjectId: t.id } });
      expect(audit).not.toBeNull();
    });
  });

  describe('authorization is per division', () => {
    it('a Member can read the library but not manage it', async () => {
      const list = await as(member.session, http().get(`/api/divisions/${writingId}/request-templates`));
      expect(list.status).toBe(200);
      expect(list.body.allowedActions).toContain('task:create');
      expect(list.body.allowedActions).not.toContain('request_template:create');
      const create = await as(member.session, http().post(`/api/divisions/${writingId}/request-templates`)).send({
        name: 'Mine',
        questions: [],
      });
      expect(create.status).toBe(403);
    });

    it('a request_template:update grant scoped to one division works there only', async () => {
      const role = (await auth(http().post('/api/roles')).send({ name: 'Template keeper' })).body.id;
      await auth(http().post('/api/grants')).send({
        roleId: role,
        action: 'request_template:update',
        scopeKind: 'specific_division',
        scopeDivisionId: artId,
      });
      const keeper = await inviteAndAccept(booted, admin, { email: 'keeper@example.com', intendedRoleIds: [role, memberRoleId] });
      const art = await createTemplate(artId, { name: 'Art piece', questions: [] });
      const writing = await createTemplate(writingId, { name: 'Writing piece', questions: [] });
      const ok = await as(keeper.session, http().patch(`/api/request-templates/${art.id}`)).send({ version: 0, name: 'Renamed' });
      expect(ok.status).toBe(200);
      const no = await as(keeper.session, http().patch(`/api/request-templates/${writing.id}`)).send({ version: 0, name: 'Nope' });
      expect(no.status).toBe(403);
    });
  });

  describe('choosing a template when creating a task (§3.8)', () => {
    it('a library template from another division is rejected', async () => {
      const artTemplate = await createTemplate(artId, { name: 'Art only', questions: [] });
      const res = await auth(http().post('/api/tasks')).send({
        name: 'Wrong',
        divisionId: writingId,
        template: { kind: 'library', templateId: artTemplate.id },
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TEMPLATE_NOT_IN_DIVISION');
    });

    it('the default kind uses the default template', async () => {
      const res = await auth(http().post('/api/tasks')).send({ name: 'Default', divisionId: writingId, template: { kind: 'default' } });
      expect(res.status).toBe(201);
      const qs = await auth(http().get(`/api/tasks/${res.body.id}/request-template`));
      expect(qs.body.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['Gist']);
    });

    describe('custom templates', () => {
      const custom = { kind: 'custom', questions: [text('Anything you like')] };
      const createAsMember = () =>
        as(member.session, http().post('/api/tasks')).send({ name: 'Custom', divisionId: writingId, template: custom });

      it('are refused when the division setting is off and no grant applies', async () => {
        const res = await createAsMember();
        expect(res.status).toBe(403);
        const list = await as(member.session, http().get(`/api/divisions/${writingId}/request-templates`));
        expect(list.body.allowedActions).not.toContain('task:compose_template');
      });

      it('are open to any requester once the division allows them', async () => {
        await auth(http().patch(`/api/divisions/${writingId}`)).send({ allowCustomTemplates: true });
        const res = await createAsMember();
        expect(res.status).toBe(201);
        expect(res.body.templateOrigin).toBe('custom');
        expect(res.body.sourceTemplateId).toBeNull();
        const qs = await as(member.session, http().get(`/api/tasks/${res.body.id}/request-template`));
        expect(qs.body.questions.map((q: { prompt: string }) => q.prompt)).toEqual(['Anything you like']);
        const list = await as(member.session, http().get(`/api/divisions/${writingId}/request-templates`));
        expect(list.body.allowedActions).toContain('task:compose_template');
      });

      it('a forbid grant blocks them even where the division allows them', async () => {
        const role = (await auth(http().post('/api/roles')).send({ name: 'No custom' })).body.id;
        await auth(http().post('/api/grants')).send({
          roleId: role,
          action: 'task:compose_template',
          effect: 'forbid',
          scopeKind: 'global',
        });
        await auth(http().post(`/api/users/${member.userId}/roles`)).send({ roleId: role });
        expect((await createAsMember()).status).toBe(403);
        await auth(http().delete(`/api/users/${member.userId}/roles/${role}`));
        await auth(http().patch(`/api/divisions/${writingId}`)).send({ allowCustomTemplates: false });
      });

      it('a task:compose_template grant permits them with the setting off', async () => {
        expect((await createAsMember()).status).toBe(403);
        const role = (await auth(http().post('/api/roles')).send({ name: 'Composer' })).body.id;
        await auth(http().post('/api/grants')).send({ roleId: role, action: 'task:compose_template', scopeKind: 'global' });
        await auth(http().post(`/api/users/${member.userId}/roles`)).send({ roleId: role });
        expect((await createAsMember()).status).toBe(201);
      });

      it('still need task:create in the division', async () => {
        const outsider = await inviteAndAccept(booted, admin, { email: 'outsider@example.com', intendedRoleIds: [memberRoleId] });
        const role = (await auth(http().post('/api/roles')).send({ name: 'Composer only' })).body.id;
        await auth(http().post('/api/grants')).send({ roleId: role, action: 'task:compose_template', scopeKind: 'global' });
        await auth(http().post(`/api/users/${outsider.userId}/roles`)).send({ roleId: role });
        const res = await as(outsider.session, http().post('/api/tasks')).send({
          name: 'Not my division',
          divisionId: writingId,
          template: custom,
        });
        expect(res.status).toBe(403);
      });
    });
  });
});
