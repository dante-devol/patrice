import { AccountApi, AuthApi } from '../core/api/auth.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { toast } from 'ngx-sonner';
import { AuthStore } from '../core/auth.store';
import { errorMessage } from '../core/errors';
import type { components } from '../core/api/schema';

type Session = components['schemas']['Session'];

const LINK_ERRORS: Record<string, string> = {
  discord_session: 'The Discord connect link expired or the session changed. Please try again.',
  discord_not_configured: 'Discord is not configured for this server.',
  discord_already_linked: 'That Discord account is already linked to another Patrice account.',
  discord_denied: 'Discord authorization was cancelled.',
  discord_error: 'Connecting Discord failed. Please try again.',
};

/**
 * The user's own account: profile, password, email, signed-in sessions, and their
 * Discord connection (sign-in method plus role-sync link; mapping roles is the
 * admins' business and lives in the admin area).
 */
@Component({
  selector: 'account-page',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .section-label { font-family:var(--font-display); font-weight:700; font-size:15px; color:var(--ink); margin-bottom:6px; }
    .conn-card { display:flex; align-items:center; gap:14px; border:1px solid var(--border); border-radius:2px; padding:16px; margin-top:8px; }
    .conn-avatar { width:48px; height:48px; border-radius:50%; background:#5865F2; display:flex; align-items:center; justify-content:center; }
    .conn-avatar img { width:48px; height:48px; border-radius:50%; object-fit:cover; }
    .conn-avatar svg { width:26px; height:26px; }
    .conn-body { flex:1; }
    .conn-title { font-weight:600; }
    .methods { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
    .discord-btn {
      display:inline-flex; align-items:center; gap:8px; background:var(--paper); color:var(--ink);
      border:1px solid var(--line); border-radius:2px; padding:8px 14px; font-size:13px; font-weight:700; cursor:pointer; text-decoration:none;
    }
    .discord-btn:hover { background:var(--paper-hover); border-color:var(--faint); }
    .discord-btn svg { width:18px; height:18px; fill:#5865F2; }
  `],
  template: `
    <div class="panel">
      <h2 style="margin:0 0 4px">Account</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">
        Manage your sign-in methods and connected accounts.
      </p>

      @if (user(); as u) {
        <div class="section-label">Profile</div>
        <p style="margin:2px 0"><strong>{{ u.displayName }}</strong></p>
        @if (u.email) { <p class="muted" style="margin:2px 0">{{ u.email }}</p> }
        <div class="methods">
          @for (m of u.authMethods; track m) {
            <span class="badge">{{ methodLabel(m) }}</span>
          }
        </div>

        <div class="section-label" style="margin-top:20px">Password</div>
        <form class="row" style="gap:8px;flex-wrap:wrap" (ngSubmit)="changePassword()">
          @if (hasPassword()) {
            <input type="password" name="currentPassword" [(ngModel)]="pw.current" placeholder="Current password" autocomplete="current-password" />
          }
          <input type="password" name="newPassword" [(ngModel)]="pw.next" placeholder="New password" autocomplete="new-password" />
          <button type="submit" class="secondary" [disabled]="busy() || !pw.next">{{ hasPassword() ? 'Change password' : 'Add a password' }}</button>
        </form>

        <div class="section-label" style="margin-top:20px">Email</div>
        <form class="row" style="gap:8px;flex-wrap:wrap" (ngSubmit)="changeEmail()">
          <input type="email" name="newEmail" [(ngModel)]="mail.next" placeholder="New email address" autocomplete="email" />
          @if (hasPassword()) {
            <input type="password" name="emailPassword" [(ngModel)]="mail.password" placeholder="Current password" autocomplete="current-password" />
          }
          <button type="submit" class="secondary" [disabled]="busy() || !mail.next">Send confirmation</button>
        </form>
        <p class="muted" style="margin:4px 0 0;font-size:12.5px">The change takes effect once you confirm it from the new address.</p>

        <div class="section-label" style="margin-top:20px">Sessions</div>
        @for (s of sessions(); track s.id) {
          <div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding:8px 0">
            <div>
              <div style="font-size:13px">{{ s.userAgent || 'Unknown device' }}@if (s.current) { <span class="badge">This device</span> }</div>
              <div class="muted" style="font-size:12.5px">{{ methodLabel(s.authMethod) }} · last active {{ when(s.lastSeenAt) }}@if (s.ip) { · {{ s.ip }}}</div>
            </div>
            @if (!s.current) { <button class="quiet danger" [disabled]="busy()" (click)="revoke(s)">Sign out</button> }
          </div>
        }

        <div class="section-label" style="margin-top:20px">Discord</div>
        @if (error()) { <p class="error">{{ error() }}</p> }

        <div class="conn-card">
          <span class="conn-avatar">
            @if (u.avatarUrl) {
              <img [src]="u.avatarUrl" alt="Discord avatar" />
            } @else {
              <svg viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
              </svg>
            }
          </span>
          <div class="conn-body">
            @if (connected()) {
              <div class="conn-title">Connected{{ u.discordHandle ? ' as ' + u.discordHandle : '' }}</div>
              <p class="muted" style="margin:2px 0;font-size:12.5px">
                Your roles sync automatically from Discord. You can sign in with Discord.
              </p>
            } @else {
              <div class="conn-title">Not connected</div>
              <p class="muted" style="margin:2px 0;font-size:12.5px">
                Connect Discord to sign in with it and sync your roles automatically.
              </p>
            }
          </div>
          @if (connected()) {
            <button class="secondary" [disabled]="busy()" (click)="disconnect()">Disconnect</button>
          } @else {
            <a class="discord-btn" href="/api/auth/discord/link">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
              </svg>
              Connect Discord
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class AccountComponent implements OnInit {
  private readonly authApi = inject(AuthApi);
  private readonly accountApi = inject(AccountApi);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);

  readonly user = this.auth.user;
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly sessions = signal<Session[]>([]);
  readonly hasPassword = computed(() => this.user()?.authMethods.includes('password') === true);
  pw = { current: '', next: '' };
  mail = { next: '', password: '' };

  readonly connected = computed(
    () => this.user()?.hasDiscordLink === true || this.user()?.authMethods.includes('discord') === true,
  );

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    if (q.get('linked')) {
      toast.success('Discord connected');
      void this.auth.refresh();
    }
    const err = q.get('error');
    if (err) this.error.set(LINK_ERRORS[err] ?? LINK_ERRORS['discord_error']);
  }

  async ngOnInit(): Promise<void> {
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await firstValueFrom(this.accountApi.listSessions()));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  async changePassword(): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(
        this.accountApi.setPassword({ newPassword: this.pw.next, ...(this.pw.current ? { currentPassword: this.pw.current } : {}) }),
      );
      this.pw = { current: '', next: '' };
      toast.success('Password saved');
      await this.auth.refresh();
    });
  }

  async changeEmail(): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(
        this.accountApi.requestEmailChange({ newEmail: this.mail.next, ...(this.mail.password ? { currentPassword: this.mail.password } : {}) }),
      );
      this.mail = { next: '', password: '' };
      toast.success('Check the new address for a confirmation link');
    });
  }

  async revoke(s: Session): Promise<void> {
    await this.run(async () => {
      await firstValueFrom(this.accountApi.revokeSession(s.id));
      await this.loadSessions();
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  methodLabel(m: string): string {
    return m === 'password' ? 'Email & password' : m.charAt(0).toUpperCase() + m.slice(1);
  }

  async disconnect(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const updated = await firstValueFrom(this.authApi.unlinkDiscord());
      this.auth.setUser(updated);
      toast.success('Discord disconnected');
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
