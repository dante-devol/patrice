import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { errorMessage } from '../core/errors';

/**
 * Setup / Bootstrap page: when no effective admin exists, the operator enters the
 * stdout bootstrap key and registers the first administrator.
 */
@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel auth">
      <h2>First-run setup</h2>
      @if (loading()) {
        <p class="muted">Checking setup status…</p>
      } @else if (!open()) {
        <p>This Patrice instance is already set up. <a routerLink="/login">Log in</a>.</p>
      } @else {
        <p class="muted">
          Enter the bootstrap key printed in the API server logs, then create the first
          administrator account.
        </p>
        <label>Bootstrap key</label>
        <input [(ngModel)]="passcode" autocomplete="off" />
        <label>Display name</label>
        <input [(ngModel)]="displayName" />
        <label>Email</label>
        <input type="email" [(ngModel)]="email" autocomplete="username" />
        <label>Password</label>
        <input type="password" [(ngModel)]="password" autocomplete="new-password" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button [disabled]="busy()" (click)="submit()">Create administrator</button>
      }
    </div>
  `,
})
export class SetupComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly open = signal(false);
  private token: string | null = null;

  passcode = '';
  displayName = '';
  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const status = await this.api.bootstrapStatus();
      this.open.set(status.open);
      this.token = status.inviteToken;
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    if (!this.token) {
      this.error.set('No bootstrap invitation is available.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const user = await this.api.acceptInvite(this.token, {
        passcode: this.passcode,
        email: this.email,
        password: this.password,
        displayName: this.displayName,
      });
      this.auth.setUser(user);
      void this.router.navigate(['/home']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
