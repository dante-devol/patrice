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

/** Slice 3.3 — division default questionnaire endpoints + 3.1 schema (issues #13/#15). */
describe('Slice 3 — Questionnaires', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let writingId: string;
  let artId: string;
  let testingId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    writingId = (await auth(http().post('/api/divisions')).send({ name: 'Writing' })).body.id;
    artId = (await auth(http().post('/api/divisions')).send({ name: 'Art' })).body.id;
    testingId = (await auth(http().post('/api/divisions')).send({ name: 'Testing' })).body.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  const allSevenTypes = [
    { type: 'detail_text', prompt: 'Your writing', required: true, constraints: { maxChars: 5000 } },
    { type: 'multiline', prompt: 'Notes', required: false, constraints: {} },
    { type: 'text', prompt: 'Title', required: true, constraints: { minChars: 1, maxChars: 120 } },
    { type: 'numeric', prompt: 'Rating', required: true, constraints: { kind: 'integer', min: 1, max: 10 } },
    { type: 'dropdown', prompt: 'Category', required: false, constraints: { multi: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
    { type: 'radio', prompt: 'Priority', required: true, constraints: { multi: false, options: [{ value: 'lo', label: 'Low' }, { value: 'hi', label: 'High' }] } },
    { type: 'attachment', prompt: 'Asset', required: true, constraints: { allowedTypes: ['image/png', 'image/jpeg'], maxFiles: 3 } },
  ];

  it('GET on a division with no questionnaire → 404', async () => {
    const res = await auth(http().get(`/api/divisions/${writingId}/questionnaire`));
    expect(res.status).toBe(404);
  });

  it('first PUT inserts a questionnaire owned by the division (owner_division_id set)', async () => {
    const res = await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'detail_text', prompt: 'Submit your writing', required: true, constraints: {} }],
    });
    expect(res.status).toBe(200);
    expect(res.body.ownerDivisionId).toBe(writingId);
    expect(res.body.questions).toHaveLength(1);

    const row = await prisma.questionnaire.findUnique({ where: { ownerDivisionId: writingId } });
    expect(row).not.toBeNull();
    expect(row!.ownerTaskId).toBeNull();
  });

  it('second PUT updates question children in place — no duplicate questionnaire row', async () => {
    const before = await prisma.questionnaire.findUnique({ where: { ownerDivisionId: writingId } });
    const res = await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [
        { type: 'detail_text', prompt: 'Submit your writing', required: true, constraints: {} },
        { type: 'text', prompt: 'Working title', required: false, constraints: { maxChars: 80 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(before!.id); // stable identity
    expect(res.body.questions).toHaveLength(2);

    const count = await prisma.questionnaire.count({ where: { ownerDivisionId: writingId } });
    expect(count).toBe(1);
  });

  it('round-trips all 7 question types with constraints (PUT → GET)', async () => {
    const put = await auth(http().put(`/api/divisions/${testingId}/questionnaire`)).send({
      questions: allSevenTypes,
    });
    expect(put.status).toBe(200);

    const get = await auth(http().get(`/api/divisions/${testingId}/questionnaire`));
    expect(get.status).toBe(200);
    expect(get.body.questions.map((q: any) => q.type)).toEqual([
      'detail_text', 'multiline', 'text', 'numeric', 'dropdown', 'radio', 'attachment',
    ]);
    // ordinals are dense and ordered
    expect(get.body.questions.map((q: any) => q.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // type-specific constraints survive the round-trip
    const numeric = get.body.questions.find((q: any) => q.type === 'numeric');
    expect(numeric.constraints).toEqual({ kind: 'integer', min: 1, max: 10 });
    const attachment = get.body.questions.find((q: any) => q.type === 'attachment');
    expect(attachment.constraints.allowedTypes).toEqual(['image/png', 'image/jpeg']);
    const radio = get.body.questions.find((q: any) => q.type === 'radio');
    expect(radio.constraints.options).toHaveLength(2);
  });

  it('empty question[] is accepted (coordination-only division)', async () => {
    const res = await auth(http().put(`/api/divisions/${artId}/questionnaire`)).send({ questions: [] });
    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([]);
    const row = await prisma.questionnaire.findUnique({ where: { ownerDivisionId: artId } });
    expect(row).not.toBeNull();
  });

  it('rejects a numeric range attached to a text question (422)', async () => {
    const res = await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Bad', constraints: { kind: 'integer', min: 1 } }],
    });
    expect(res.status).toBe(422);
  });

  it('rejects an out-of-order numeric range (min > max) at 422', async () => {
    const res = await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'numeric', prompt: 'Bad', constraints: { kind: 'integer', min: 10, max: 1 } }],
    });
    expect(res.status).toBe(422);
  });

  it('writes an activity row with IDs-only payload', async () => {
    await auth(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
      questions: [{ type: 'text', prompt: 'Title', required: true, constraints: {} }],
    });
    const row = await prisma.activity.findFirst({
      where: { verb: 'questionnaire.updated', subjectType: 'questionnaire' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    const payload = row!.payload as Record<string, unknown>;
    expect(payload.divisionId).toBe(writingId);
    expect(typeof payload.questionnaireId).toBe('string');
    expect(payload.questionCount).toBe(1);
    // No PII leaked into the audit payload.
    expect(JSON.stringify(payload)).not.toContain('Title');
  });

  describe('per-division scoping', () => {
    let scopedSession: AdminSession;

    beforeAll(async () => {
      // A standalone role that may edit ONLY the Writing division.
      const role = await auth(http().post('/api/roles')).send({ name: 'WritingDivAdmin' });
      const roleId = role.body.id;
      const grant = await auth(http().post('/api/grants')).send({
        roleId,
        action: 'division:update',
        scopeKind: 'specific_division',
        scopeDivisionId: writingId,
      });
      expect(grant.status).toBe(201);
      const { session } = await inviteAndAccept(booted, admin, {
        email: 'writinglead@example.com',
        intendedRoleIds: [roleId],
      });
      scopedSession = session;
    });

    const asScoped = (r: request.Test) =>
      r.set('Cookie', scopedSession.cookies).set('x-csrf-token', scopedSession.csrf);

    it('a specific_division admin may PUT their own division', async () => {
      const res = await asScoped(http().put(`/api/divisions/${writingId}/questionnaire`)).send({
        questions: [{ type: 'text', prompt: 'Owned edit', required: false, constraints: {} }],
      });
      expect(res.status).toBe(200);
    });

    it('PUT by a non-owner division is rejected (403)', async () => {
      const res = await asScoped(http().put(`/api/divisions/${artId}/questionnaire`)).send({
        questions: [],
      });
      expect(res.status).toBe(403);
    });
  });

  describe('schema-enforced ownership exclusivity (#13)', () => {
    it('UNIQUE(owner_division_id) prevents a second questionnaire for one division', async () => {
      await expect(
        prisma.questionnaire.create({
          data: { organizationId: (await prisma.organization.findFirstOrThrow()).id, ownerDivisionId: writingId },
        }),
      ).rejects.toThrow();
    });

    it('CHECK rejects a row with both owner columns set (two-owner rejection)', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO questionnaire (organization_id, owner_division_id, owner_task_id, updated_at)
           VALUES ($1::uuid, $2::uuid, gen_random_uuid(), now())`,
          orgId,
          testingId,
        ),
      ).rejects.toThrow();
    });

    it('CHECK rejects a row with neither owner column set', async () => {
      const orgId = (await prisma.organization.findFirstOrThrow()).id;
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO questionnaire (organization_id, updated_at) VALUES ($1::uuid, now())`,
          orgId,
        ),
      ).rejects.toThrow();
    });
  });
});
