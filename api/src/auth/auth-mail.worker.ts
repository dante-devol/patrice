import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AuthTokenKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { JobRunner } from '../queue/job-runner.service';
import { EmailService } from '../email/email.service';
import { generateOpaqueToken, hashToken } from '../common/tokens';
import type { AuthMailJob } from './auth-mail.service';

const TTL_MS: Record<AuthTokenKind, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  email_change: 24 * 60 * 60 * 1000,
};

/**
 * Worker: mints a single-use auth token, stores its hash and mails the link. A failed
 * send throws, so the job is retried (and dead-lettered if it keeps failing).
 */
@Injectable()
export class AuthMailWorker implements OnModuleInit {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly runner: JobRunner,
  ) {}

  onModuleInit(): void {
    this.runner.register('auth.mail', (data) => this.run(data as AuthMailJob));
  }

  async run(job: AuthMailJob): Promise<void> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: job.userId },
      select: { email: true, lifecycleState: true },
    });
    if (!user || user.lifecycleState !== 'active') return;
    const to = job.kind === 'email_change' ? job.newEmail : user.email;
    if (!to) return;

    const token = generateOpaqueToken();
    await this.prisma.authToken.create({
      data: {
        userId: job.userId,
        kind: job.kind,
        tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
        expiresAt: new Date(Date.now() + TTL_MS[job.kind]),
        newEmail: job.kind === 'email_change' ? job.newEmail : null,
      },
    });
    switch (job.kind) {
      case 'email_verification':
        return this.email.sendVerificationEmail(to, token);
      case 'password_reset':
        return this.email.sendPasswordResetEmail(to, token);
      case 'email_change':
        return this.email.sendEmailChangeEmail(to, token);
    }
  }
}
