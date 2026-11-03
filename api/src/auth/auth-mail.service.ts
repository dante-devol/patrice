import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AuthTokenKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { EmailService } from '../email/email.service';
import { generateOpaqueToken, hashToken } from '../common/tokens';

const AUTH_MAIL_QUEUE = 'auth.mail';

const TTL_MS: Record<AuthTokenKind, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  email_change: 24 * 60 * 60 * 1000,
};

/** A request to mail a single-use link. Carries no token: the job mints it. */
type AuthMailJob =
  | { kind: 'email_verification'; userId: string }
  | { kind: 'password_reset'; userId: string }
  | { kind: 'email_change'; userId: string; newEmail: string };

/**
 * Single-use auth links (verify email, reset password, confirm an email change). The
 * request path only enqueues "mail this user a link"; the job mints the token, stores
 * its hash and sends the mail. A plaintext bearer token therefore exists only inside
 * the job run and the email, never in the job table.
 */
@Injectable()
export class AuthMailService implements OnModuleInit {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly email: EmailService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.work(AUTH_MAIL_QUEUE, (data) => this.run(data as AuthMailJob));
  }

  async request(job: AuthMailJob): Promise<void> {
    await this.queue.publish(AUTH_MAIL_QUEUE, job, { runInlineWhenUnavailable: true });
  }

  private async run(job: AuthMailJob): Promise<void> {
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
