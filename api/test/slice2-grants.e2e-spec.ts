/* eslint-disable */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AccessService } from '../src/access/access.service';
import {
  AdminSession,
  BootedApp,
  bootApp,
  bootstrapAdmin,
  createEmailCapture,
  resetDatabase,
} from './helpers';

/** Slice 2.3 — Permission Matrix + Grants + Cedar re-projection (issue #10). */
describe('Slice 2.3 — Permission Matrix + Grants', () => {
  let booted: BootedApp;
  let app: INestApplication;
  let admin: AdminSession;
  let prisma: PrismaClient;
  let access: AccessService;

  let writingId: string;
  let artId: string;
  let writingRoleId: string; // inherent division role for Writing
  let leadRoleId: string; // standalone WritingLead

  beforeAll(async () => {
    await resetDatabase();
    const { stub } = createEmailCapture();
    booted = await bootApp({ emailStub: stub });
    app = booted.app;
    admin = await bootstrapAdmin(booted);
    prisma = new PrismaClient();
    access = app.get(AccessService);

    const w = await auth(http().post('/api/divisions')).send({ name: 'Writing' });
    writingId = w.body.id;
    writingRoleId = w.body.inherentRoleId;
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

  it('GET /actions exposes the full closed vocabulary', async () => {
    const res = await auth(http().get('/api/actions'));
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(
      expect.arrayContaining(['task:review', 'grant:create', 'config:update']),
    );
  });

  it('rejects an unknown action with 422', async () => {
    const res = await auth(http().post('/api/grants')).send({
      roleId: leadRoleId,
      action: 'task:teleport',
      scopeKind: 'global',
    });
    expect(res.status).toBe(422);
  });

  it('rejects a structurally impossible action/scope combo at 422 (own with no owner)', async () => {
    const res = await auth(http().post('/api/grants')).send({
      roleId: leadRoleId,
      action: 'task:review',
      scopeKind: 'own',
    });
    expect(res.status).toBe(422);
  });

  it('rejects scoping a governance action by division at 422 (schema validation)', async () => {
    const res = await auth(http().post('/api/grants')).send({
      roleId: leadRoleId,
      action: 'grant:create',
      scopeKind: 'specific_division',
      scopeDivisionId: writingId,
    });
    expect(res.status).toBe(422);
  });

  let grantId: string;
  let configVersionBefore: bigint;

  it('grants task:review @ own_division to WritingLead and bumps config_version', async () => {
    const org = await prisma.organization.findFirstOrThrow({
      select: { configVersion: true },
    });
    configVersionBefore = org.configVersion;

    const res = await auth(http().post('/api/grants')).send({
      roleId: leadRoleId,
      action: 'task:review',
      scopeKind: 'own_division',
    });
    expect(res.status).toBe(201);
    grantId = res.body.id;

    const after = await prisma.organization.findFirstOrThrow({
      select: { configVersion: true },
    });
    expect(after.configVersion > configVersionBefore).toBe(true);
  });

  it('Cedar engine: a WritingLead member of Writing passes task:review on Writing, fails on Art', async () => {
    // A user holding WritingLead (for the action grant) AND the Writing inherent
    // role (for own_division membership).
    const user = await prisma.appUser.create({
      data: {
        organizationId: (await prisma.organization.findFirstOrThrow()).id,
        email: 'lead@example.com',
        displayName: 'Lead',
      },
      select: { id: true },
    });
    await prisma.userRole.createMany({
      data: [
        { userId: user.id, roleId: leadRoleId },
        { userId: user.id, roleId: writingRoleId },
      ],
    });

    const taskOn = (divisionId: string) => ({
      type: 'Task' as const,
      id: randomUUID(),
      attrs: {
        division: { __entity: { type: 'Patrice::Division', id: divisionId } },
        retired: false,
      },
    });

    const onWriting = await access.decide({
      userId: user.id,
      action: 'task:review',
      resource: taskOn(writingId),
    });
    const onArt = await access.decide({
      userId: user.id,
      action: 'task:review',
      resource: taskOn(artId),
    });
    expect(onWriting).toBe(true);
    expect(onArt).toBe(false);
  });

  it('retiring the grant removes it from projection (member no longer passes)', async () => {
    const res = await auth(http().post(`/api/grants/${grantId}/retire`));
    expect(res.status).toBe(201);

    const user = await prisma.appUser.findFirstOrThrow({
      where: { email: 'lead@example.com' },
      select: { id: true },
    });
    const onWriting = await access.decide({
      userId: user.id,
      action: 'task:review',
      resource: {
        type: 'Task',
        id: randomUUID(),
        attrs: {
          division: { __entity: { type: 'Patrice::Division', id: writingId } },
          retired: false,
        },
      },
    });
    expect(onWriting).toBe(false);
  });

  it('reviving the grant restores it', async () => {
    const res = await auth(http().post(`/api/grants/${grantId}/revive`));
    expect(res.status).toBe(201);
    const user = await prisma.appUser.findFirstOrThrow({
      where: { email: 'lead@example.com' },
      select: { id: true },
    });
    const onWriting = await access.decide({
      userId: user.id,
      action: 'task:review',
      resource: {
        type: 'Task',
        id: randomUUID(),
        attrs: {
          division: { __entity: { type: 'Patrice::Division', id: writingId } },
          retired: false,
        },
      },
    });
    expect(onWriting).toBe(true);
  });
});
