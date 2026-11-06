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

/** The permission editor's staged save: `POST /grants/batch`, all-or-nothing. */
describe('Batch grant changes', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;

  let artId: string;
  let leadRoleId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();

    await auth(http().post('/api/divisions')).send({ name: 'Writing' });
    const a = await auth(http().post('/api/divisions')).send({ name: 'Art' });
    artId = a.body.id;
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
  const configVersion = async () =>
    (await prisma.systemSettings.findFirstOrThrow({ select: { configVersion: true } })).configVersion;
  const leadGrants = () =>
    prisma.grant.findMany({
      where: { roleId: leadRoleId },
      orderBy: { action: 'asc' },
    });

  it('GET /actions describes each action’s assignable scopes', async () => {
    const res = await auth(http().get('/api/actions'));
    expect(res.status).toBe(200);
    const byAction = Object.fromEntries(
      (res.body.catalog as { action: string; scopes: string[] }[]).map((a) => [a.action, a]),
    );
    expect(byAction['task:review']).toEqual({
      action: 'task:review',
      resourceType: 'Task',
      scopes: ['global', 'own_division', 'own_team', 'specific_division', 'specific_team', 'own', 'assigned'],
      own: 'requester',
    });
    expect(byAction['grant:create'].scopes).toEqual(['global']);
    expect(byAction['user:grant_role'].scopes).toEqual(['global', 'role']);
  });

  it('applies creates together with one config_version bump', async () => {
    const before = await configVersion();
    const res = await auth(http().post('/api/grants/batch')).send({
      changes: [
        { op: 'create', roleId: leadRoleId, action: 'task:review', scopeKind: 'own_division' },
        { op: 'create', roleId: leadRoleId, action: 'task:retire', scopeKind: 'own_team' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await configVersion()).toBe(before + 1n);
    expect((await leadGrants()).map((g) => [g.action, g.scopeKind])).toEqual([
      ['task:retire', 'own_team'],
      ['task:review', 'own_division'],
    ]);
  });

  it('re-scopes and deletes in the same save', async () => {
    const [retire, review] = await leadGrants();
    const res = await auth(http().post('/api/grants/batch')).send({
      changes: [
        {
          op: 'update',
          id: review.id,
          version: review.version,
          scopeKind: 'specific_division',
          scopeDivisionId: artId,
        },
        { op: 'delete', id: retire.id, version: retire.version },
      ],
    });
    expect(res.status).toBe(200);
    const after = await leadGrants();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: review.id,
      scopeKind: 'specific_division',
      scopeDivisionId: artId,
      version: review.version + 1,
    });
  });

  it('refuses the whole batch when one change is invalid', async () => {
    const before = await leadGrants();
    const res = await auth(http().post('/api/grants/batch')).send({
      changes: [
        { op: 'create', roleId: leadRoleId, action: 'task:create', scopeKind: 'global' },
        { op: 'create', roleId: leadRoleId, action: 'config:update', scopeKind: 'own' },
      ],
    });
    expect(res.status).toBe(422);
    expect(await leadGrants()).toEqual(before);
  });

  it('refuses a stale version with 409 and writes nothing', async () => {
    const [review] = await leadGrants();
    const res = await auth(http().post('/api/grants/batch')).send({
      changes: [
        { op: 'create', roleId: leadRoleId, action: 'task:create', scopeKind: 'global' },
        { op: 'delete', id: review.id, version: review.version - 1 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_GRANT');
    expect((await leadGrants()).map((g) => g.id)).toEqual([review.id]);
  });

  it('refuses a save that would leave no effective admin', async () => {
    const governance = await prisma.grant.findMany({
      where: {
        scopeKind: 'global',
        action: { in: ['grant:create', 'grant:update', 'grant:delete', 'role:create', 'role:update', 'role:retire'] },
      },
    });
    const res = await auth(http().post('/api/grants/batch')).send({
      changes: governance.map((g) => ({ op: 'delete', id: g.id, version: g.version })),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
    expect(
      await prisma.grant.count({ where: { id: { in: governance.map((g) => g.id) } } }),
    ).toBe(governance.length);
  });
});
