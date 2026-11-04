import { Injectable } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';

/** A request to mail a single-use link. Carries no token: the job mints it. */
export type AuthMailJob =
  | { kind: 'email_verification'; userId: string }
  | { kind: 'password_reset'; userId: string }
  | { kind: 'email_change'; userId: string; newEmail: string };

/**
 * Single-use auth links (verify email, reset password, confirm an email change). The
 * request path only enqueues "mail this user a link"; the worker's
 * {@link AuthMailWorker} mints the token, stores its hash and sends the mail, so a
 * plaintext bearer token exists only inside the job run and the email, never in the
 * job table. If the job can't be queued the request fails (503), rather than the
 * user waiting for a mail that will never come.
 */
@Injectable()
export class AuthMailService {
  constructor(private readonly queue: QueueService) {}

  async request(job: AuthMailJob): Promise<void> {
    await this.queue.publish('auth.mail', job);
  }

  /**
   * Fail (503) when mail can't be queued. Callers that must answer the same way for
   * known and unknown addresses check this before looking the address up.
   */
  assertAvailable(): void {
    this.queue.assertAvailable();
  }
}
