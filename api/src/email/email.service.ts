import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { ENV, Env } from '../config/env';

/**
 * SMTP email via nodemailer. Sends synchronously: callers run inside a queue job
 * (see AuthMailService), so a slow SMTP server never blocks a request. Links are
 * built against `PUBLIC_BASE_URL`. A failed send throws, so the job can retry.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private transporter: Transporter | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  onModuleInit(): void {
    this.transporter = createTransport(this.env.SMTP_URL);
  }

  private async deliver(to: string, subject: string, text: string, html: string): Promise<void> {
    if (!this.transporter) return;
    await this.transporter.sendMail({ from: this.env.EMAIL_FROM, to, subject, text, html });
  }

  private link(path: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const url = this.link(`/verify-email?token=${encodeURIComponent(token)}`);
    await this.deliver(
      to,
      'Verify your Patrice email',
      `Confirm your email address: ${url}`,
      `<p>Confirm your email address: <a href="${url}">${url}</a></p>`,
    );
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const url = this.link(`/reset-password?token=${encodeURIComponent(token)}`);
    await this.deliver(
      to,
      'Reset your Patrice password',
      `Reset your password: ${url}`,
      `<p>Reset your password: <a href="${url}">${url}</a></p>`,
    );
  }

  async sendEmailChangeEmail(to: string, token: string): Promise<void> {
    const url = this.link(`/confirm-email-change?token=${encodeURIComponent(token)}`);
    await this.deliver(
      to,
      'Confirm your new Patrice email address',
      `Confirm this is your new email address: ${url}`,
      `<p>Confirm this is your new email address: <a href="${url}">${url}</a></p>`,
    );
  }
}
