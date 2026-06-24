import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { errorMessage } from '../core/errors';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel auth">
      <h2>Choose a new password</h2>
      @if (!token) {
        <p class="error">This reset link is missing its token.</p>
      } @else if (done()) {
        <p class="muted">
          Your password has been reset and all sessions were signed out.
          <a routerLink="/login">Log in</a>.
        </p>
      } @else {
        <label>New password</label>
        <input type="password" [(ngModel)]="password" autocomplete="new-password" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button [disabled]="busy()" (click)="submit()">Reset password</button>
      }
    </div>
  `,
})
export class ResetPasswordComponent {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  token = this.route.snapshot.queryParamMap.get('token') ?? '';
  password = '';
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.confirmPasswordReset(this.token, this.password);
      this.done.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
