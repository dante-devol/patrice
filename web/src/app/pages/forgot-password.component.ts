import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel auth">
      <h2>Reset your password</h2>
      <p class="muted">
        Enter your email and we'll send a reset link if an account exists.
      </p>
      <label>Email</label>
      <input type="email" [(ngModel)]="email" autocomplete="username" />
      <button [disabled]="busy()" (click)="submit()">Send reset link</button>
      @if (sent()) {
        <p class="muted">If that email is registered, a reset link is on its way.</p>
      }
      <p class="muted"><a routerLink="/login">Back to login</a></p>
    </div>
  `,
})
export class ForgotPasswordComponent {
  private readonly api = inject(ApiService);
  email = '';
  readonly busy = signal(false);
  readonly sent = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.requestPasswordReset(this.email);
      this.sent.set(true); // success is unconditional (no enumeration oracle)
    } finally {
      this.busy.set(false);
    }
  }
}
