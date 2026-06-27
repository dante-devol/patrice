import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { errorMessage } from '../core/errors';

/** Human messages for the `?error=` codes the Discord callback redirects with. */
const DISCORD_ERRORS: Record<string, string> = {
  discord_no_account: 'No Patrice account is linked to that Discord login. Ask an admin for an invitation, or log in another way and link Discord from your profile.',
  discord_denied: 'Discord sign-in was cancelled.',
  discord_state: 'That Discord sign-in link expired. Please try again.',
  discord_not_configured: 'Discord sign-in is not configured for this server.',
  discord_already_linked: 'That Discord account is already linked to another Patrice account.',
  discord_error: 'Discord sign-in failed. Please try again.',
};

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  styles: [`
    .or { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:12px; margin:14px 0; }
    .or::before, .or::after { content:''; flex:1; height:1px; background:var(--border); }
    .discord-btn {
      display:flex; align-items:center; justify-content:center; gap:8px;
      width:100%; background:#5865F2; color:#fff; border:none; border-radius:8px;
      padding:10px 14px; font-weight:600; cursor:pointer; text-decoration:none;
    }
    .discord-btn:hover { background:#4752c4; }
    .discord-btn svg { width:18px; height:18px; }
  `],
  template: `
    <div class="panel auth">
      <h2>Log in</h2>
      <label>Email</label>
      <input type="email" [(ngModel)]="email" autocomplete="username" />
      <label>Password</label>
      <input type="password" [(ngModel)]="password" autocomplete="current-password" />
      @if (error()) { <p class="error">{{ error() }}</p> }
      <button [disabled]="busy()" (click)="submit()">Log in</button>

      <div class="or">or</div>
      <a class="discord-btn" href="/api/auth/discord/login">
        <svg viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
          <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
        </svg>
        Continue with Discord
      </a>

      <p class="muted" style="margin-top:14px">
        <a routerLink="/forgot-password">Forgot password?</a>
      </p>
    </div>
  `,
})
export class LoginComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // Surface a Discord callback error (?error=...) if we were redirected here.
    const code = this.route.snapshot.queryParamMap.get('error');
    if (code) this.error.set(DISCORD_ERRORS[code] ?? DISCORD_ERRORS['discord_error']);
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
