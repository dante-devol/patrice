import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { ENV, Env } from '../config/env';
import { QueueService } from '../queue/queue.service';

const EMAIL_QUEUE = 'email.send';

interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * SMTP email via nodemailer, dispatched through the pg-boss queue so a slow or
 * down SMTP server never blocks a request. Verification/reset links are built
 * against `PUBLIC_BASE_URL`. Callers must treat sending as best-effort — the
 * verify-email flow returns success unconditionally to avoid an enumeration oracle.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly queue: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.transporter = createTransport(this.env.SMTP_URL);
    await this.queue.work(EMAIL_QUEUE, async (data) => {
      await this.deliver(data as EmailJob);
    });
  }

  private async deliver(job: EmailJob): Promise<void> {
    if (!this.transporter) return;
    try {
      await this.transporter.sendMail({
        from: this.env.EMAIL_FROM,
        to: job.to,
        subject: job.subject,
        text: job.text,
        html: job.html,
      });
    } catch (err) {
      this.logger.error(`Email send failed to ${job.to}: ${(err as Error).message}`);
    }
  }

  private link(path: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = this.link(`/verify-email?token=${encodeURIComponent(token)}`);
    await this.queue.publish(EMAIL_QUEUE, {
      to,
      subject: 'Verify your Patrice email',
      text: `Confirm your email address: ${url}`,
      html: `<p>Confirm your email address: <a href="${url}">${url}</a></p>`,
    } satisfies EmailJob);
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const url = this.link(`/reset-password?token=${encodeURIComponent(token)}`);
    await this.queue.publish(EMAIL_QUEUE, {
      to,
      subject: 'Reset your Patrice password',
      text: `Reset your password: ${url}`,
      html: `<p>Reset your password: <a href="${url}">${url}</a></p>`,
    } satisfies EmailJob);
  }
}
