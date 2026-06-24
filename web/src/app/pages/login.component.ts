import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { errorMessage } from '../core/errors';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel auth">
      <h2>Log in</h2>
      <label>Email</label>
      <input type="email" [(ngModel)]="email" autocomplete="username" />
      <label>Password</label>
      <input type="password" [(ngModel)]="password" autocomplete="current-password" />
      @if (error()) { <p class="error">{{ error() }}</p> }
      <button [disabled]="busy()" (click)="submit()">Log in</button>
      <p class="muted">
        <a routerLink="/forgot-password">Forgot password?</a>
      </p>
    </div>
  `,
})
export class LoginComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);

  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // On a fresh install (no effective admin yet) send the user to setup instead
    // of stranding them at a login form they can't possibly satisfy.
    void this.redirectToSetupIfBootstrapping();
  }

  private async redirectToSetupIfBootstrapping(): Promise<void> {
    try {
      const status = await this.api.bootstrapStatus();
      if (status.open) void this.router.navigate(['/setup']);
    } catch {
      // Ignore — stay on the login form.
    }
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const user = await this.api.login(this.email, this.password);
      this.auth.setUser(user);
      void this.router.navigate(['/home']);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
