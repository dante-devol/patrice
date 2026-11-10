import { Inject, Injectable } from '@nestjs/common';
import { EmailService } from '../../api/src/email/email.service';
import { ENV, Env } from '../../api/src/config/env';

/** A message as Patrice built it, filed instead of sent. */
export interface DemoMail {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  date: string;
  read: boolean;
}

/** Where the demo files mail (the worker keeps it per build; Node just logs it). */
export interface Mailbox {
  deliver(mail: Omit<DemoMail, 'id' | 'date' | 'read'>): Promise<void>;
}

export const MAILBOX = Symbol('DEMO_MAILBOX');

/**
 * The real EmailService (its templates, links and subjects), with its SMTP transport
 * swapped for one that files each message in the demo's mailbox.
 */
@Injectable()
export class DemoEmailService extends EmailService {
  constructor(@Inject(ENV) env: Env, @Inject(MAILBOX) private readonly mailbox: Mailbox) {
    super(env);
  }

  override onModuleInit(): void {
    const mailbox = this.mailbox;
    // The base class keeps a private Nodemailer transporter and only calls sendMail.
    (this as unknown as { transporter: unknown }).transporter = {
      async sendMail(msg: { to: string; from: string; subject: string; text: string; html: string }) {
        await mailbox.deliver({ to: msg.to, from: msg.from, subject: msg.subject, text: msg.text, html: msg.html });
      },
    };
  }
}
