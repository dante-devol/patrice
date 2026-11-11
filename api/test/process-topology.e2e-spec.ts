import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import PgBoss from 'pg-boss';
import { ApiModule } from '../src/api.module';
import { WorkerModule } from '../src/worker.module';
import { JobRunner } from '../src/queue/job-runner.service';
import { QueueService } from '../src/queue/queue.service';
import { EmailService } from '../src/email/email.service';
import { IntegrationGatewayService } from '../src/integrations/gateway/integration-gateway.service';
import { TokenVault } from '../src/integrations/token-vault';
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
 * Phase 5 done-criteria: the API and worker are separate by construction, background
 * work fails loudly, and admin changes reach the worker's Gateway without a restart.
 */
describe('Process topology and background work', () => {
  describe('the composition', () => {
    it('the API process has no job runner, email, or Gateway', async () => {
      const api = await Test.createTestingModule({ imports: [ApiModule] }).compile();
      for (const token of [JobRunner, EmailService, IntegrationGatewayService]) {
        expect(() => api.get(token, { strict: false })).toThrow();
      }
      // It can still publish.
      expect(api.get(QueueService, { strict: false })).toBeDefined();
      await api.close();
    });

    it('the API runs without the bot-token key, which only the worker holds (D13)', async () => {
      const key = process.env.INTEGRATION_TOKEN_KEY;
      delete process.env.INTEGRATION_TOKEN_KEY;
      try {
        const api = await Test.createTestingModule({ imports: [ApiModule] }).compile();
        await api.init();
        expect(() => api.get(TokenVault, { strict: false })).toThrow();
        await api.close();
        await expect(Test.createTestingModule({ imports: [WorkerModule] }).compile()).rejects.toThrow(/INTEGRATION_TOKEN_KEY/);
      } finally {
        process.env.INTEGRATION_TOKEN_KEY = key;
      }
    });

    it('the worker consumes every queue it schedules', async () => {
      const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      await worker.init();
      const { queues, schedules } = worker.get(JobRunner).registration;
      expect(Object.keys(schedules).sort()).toEqual(['events.deliver', 'gc.sweep', 'integration.reconcile-floor']);
      for (const q of Object.keys(schedules)) expect(queues).toContain(q);
      expect(queues).toEqual(expect.arrayContaining(['auth.mail', 'integration.sync', 'gateway.reconcile-sessions']));
      await worker.close();
    });
  });

  describe('in the running app', () => {
    let booted: BootedApp;
    let app: INestApplication;
    let admin: AdminSession;
    const http = () => request(app.getHttpServer());
    const auth = (r: request.Test) => r.set('Cookie', admin.cookies).set('x-csrf-token', admin.csrf);

    beforeAll(async () => {
      await resetDatabase();
      booted = await bootApp({ emailStub: createEmailCapture().stub });
      app = booted.app;
      admin = await bootstrapAdmin(booted);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('a stopped queue makes /health degraded and mail requests fail visibly', async () => {
      const queue = app.get(QueueService);
      await queue.stop();
      try {
        const health = await http().get('/api/health');
        expect(health.body).toEqual({ status: 'degraded', db: 'ok', queue: 'down' });
        // The same answer for a known and an unknown address: no enumeration oracle.
        for (const email of ['admin@example.com', 'nobody@example.com']) {
          const res = await http().post('/api/auth/password-reset').send({ email });
          expect(res.status).toBe(503);
          expect(res.body.error.code).toBe('QUEUE_UNAVAILABLE');
        }
      } finally {
        await queue.start();
      }
      expect((await http().get('/api/health')).body.status).toBe('ok');
    });

    it('a new Discord connection gets a Gateway session without a worker restart (D21)', async () => {
      const gateway = app.get(IntegrationGatewayService);
      const res = await auth(http().post('/api/integrations')).send({
        provider: 'discord',
        externalWorkspaceId: 'topology-guild',
        displayName: 'Topology',
        botToken: 'fake-bot-token',
      });
      expect(res.status).toBe(201);
      const id = res.body.id as string;
      expect(gateway.hasSession(id)).toBe(true);

      await auth(http().post(`/api/integrations/${id}/retire`));
      expect(gateway.hasSession(id)).toBe(false);
      await auth(http().post(`/api/integrations/${id}/revive`));
      expect(gateway.hasSession(id)).toBe(true);
    });

    it('lists dead-lettered jobs for admins only', async () => {
      const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, supervise: false, schedule: false });
      await boss.start();
      try {
        await boss.send('auth.mail.dead', { kind: 'password_reset', userId: 'x' });
      } finally {
        await boss.stop({ graceful: false });
      }
      const res = await auth(http().get('/api/jobs/dead-letters'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ queue: 'auth.mail' });
      expect(res.body[0]).not.toHaveProperty('data');
      const member = await inviteAndAccept(booted, admin, { email: 'm@example.com', intendedRoleIds: [] });
      const denied = await http().get('/api/jobs/dead-letters').set('Cookie', member.session.cookies);
      expect(denied.status).toBe(403);
    });
  });
});
