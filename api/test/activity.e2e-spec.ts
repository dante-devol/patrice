import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  inviteAndAccept,
  resetDatabase,
} from './helpers';

/** Activity audit read endpoint — gating, filters, actor-name join, pagination. */
describe('Activity log — GET /api/activity', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let roleId: string;

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    // Generate a few attributable rows.
    const role = await auth(http().post('/api/roles')).send({ name: 'Auditable' });
    roleId = role.body.id;
    await auth(http().patch(`/api/roles/${roleId}`)).send({ name: 'Auditable2' });
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) =>
    r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

  it('returns the feed newest-first with the actor name joined', async () => {
    const res = await http().get('/api/activity').set('Cookie', admin.cookies);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);

    const roleRow = res.body.items.find((a: any) => a.verb === 'role.created');
    expect(roleRow).toBeDefined();
    expect(roleRow.actorName).toBe('Admin'); // joined at read time (payload is IDs-only)
    expect(roleRow.payload.roleId).toBe(roleId);

    // Newest-first: ids are descending.
    const ids = res.body.items.map((a: any) => a.id);
    expect([...ids].sort((x, y) => (x < y ? 1 : -1))).toEqual(ids);
  });

  it('filters by category (verbPrefix) and by actor', async () => {
    const byPrefix = await http()
      .get('/api/activity?verbPrefix=role')
      .set('Cookie', admin.cookies);
    expect(byPrefix.status).toBe(200);
    expect(byPrefix.body.items.length).toBeGreaterThanOrEqual(2);
    expect(byPrefix.body.items.every((a: any) => a.verb.startsWith('role'))).toBe(true);

    const me = await http().get('/api/me').set('Cookie', admin.cookies);
    const byActor = await http()
      .get(`/api/activity?actorUserId=${me.body.id}`)
      .set('Cookie', admin.cookies);
    expect(byActor.status).toBe(200);
    expect(byActor.body.items.every((a: any) => a.actorUserId === me.body.id)).toBe(true);
  });

  it('keyset-paginates via nextCursor', async () => {
    const first = await http().get('/api/activity?limit=1').set('Cookie', admin.cookies);
    expect(first.body.items.length).toBe(1);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await http()
      .get(`/api/activity?limit=1&after=${first.body.nextCursor}`)
      .set('Cookie', admin.cookies);
    expect(second.body.items.length).toBe(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect(second.body.items[0].id < first.body.items[0].id).toBe(true);
  });

  it('is admin-gated — a base user (no governance grant) gets 403', async () => {
    const { session: base } = await inviteAndAccept(booted, admin, {
      email: 'base@example.com',
    });
    const res = await http().get('/api/activity').set('Cookie', base.cookies);
    expect(res.status).toBe(403);
  });
});
