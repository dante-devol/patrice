import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/errors';

/**
 * Confirms an email-verification token (from the emailed link) or lets a signed-in
 * user request a fresh verification email.
 */
@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel auth">
      <h2>Email verification</h2>
      @if (token) {
        @if (confirming()) { <p class="muted">Verifying…</p> }
        @else if (confirmed()) {
          <p class="muted">Your email is verified. <a routerLink="/login">Log in</a>.</p>
        } @else {
          <p class="error">{{ error() }}</p>
        }
      } @else {
        <p class="muted">Enter your email to receive a new verification link.</p>
        <label>Email</label>
        <input type="email" [(ngModel)]="email" autocomplete="username" />
        <button [disabled]="busy()" (click)="resend()">Resend verification</button>
        @if (sent()) {
          <p class="muted">If that email needs verification, a link is on its way.</p>
        }
      }
    </div>
  `,
})
export class VerifyEmailComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  token = this.route.snapshot.queryParamMap.get('token') ?? '';
  email = '';
  readonly confirming = signal(false);
  readonly confirmed = signal(false);
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    if (this.token) void this.confirm();
  }

  private async confirm(): Promise<void> {
    this.confirming.set(true);
    try {
      await this.api.confirmVerification(this.token);
      this.confirmed.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.confirming.set(false);
    }
  }

  async resend(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.resendVerification(this.email);
      this.sent.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}
