import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AuthStore } from '../core/auth.store';
import { InviteView, IntegrationConnection, OrgSettings } from '../core/api.types';
import { errorMessage } from '../core/errors';

type Step = 'register' | 'link-discord' | 'done';

@Component({
  standalone: true,
  imports: [FormsModule],
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
      <h2>Accept invitation</h2>
      @if (loading()) {
        <p class="muted">Loading invitation…</p>
      } @else if (!invite()) {
        <p class="error">{{ error() }}</p>
      } @else if (invite()!.status !== 'pending') {
        <p class="error">This invitation is {{ invite()!.status }}.</p>
      } @else if (step() === 'register') {
        @if (invite()!.requiresPasscode) {
          <label>Passcode</label>
          <input [(ngModel)]="passcode" autocomplete="off" />
        }
        <label>Display name</label>
        <input [(ngModel)]="displayName" />
        <label>Email</label>
        <input type="email" [(ngModel)]="email" autocomplete="username" />
        @if (invite()!.requiresEmail) {
          <p class="muted">Enter the email address this invitation was sent to.</p>
        }
        <label>Password</label>
        <input type="password" [(ngModel)]="password" autocomplete="new-password" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button [disabled]="busy()" (click)="submit()">Create account</button>

        @if (!invite()!.requiresPasscode) {
          <div class="or">or</div>
          <a class="discord-btn" [href]="discordRegisterUrl()">
            <svg viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
              <path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            Continue with Discord
          </a>
          <p class="muted" style="font-size:12px;margin-top:8px">
            Registering with Discord sets it as your sign-in method and (if this server
            has a Discord connection) syncs your roles automatically.
          </p>
        }
      } @else if (step() === 'link-discord') {
        <h2>Link your Discord account</h2>
        @if (settings()?.requireDiscordLink) {
          <p>
            This organisation requires a linked Discord account before you can access tasks.
            Link now, or skip and link later from your profile — you won't be able to view
            tasks until you do.
          </p>
        } @else {
          <p class="muted">
            Optionally link your Discord account to sync roles automatically.
            You can always do this later from your profile.
          </p>
        }
        @if (error()) { <p class="error">{{ error() }}</p> }
        <div class="row" style="gap:8px;justify-content:flex-start;margin-top:4px">
          <button [disabled]="busy()" (click)="startDiscordLink()">
            Link Discord account
          </button>
          <button class="secondary" (click)="skipDiscordLink()">
            {{ settings()?.requireDiscordLink ? 'Skip for now' : 'Skip' }}
          </button>
        </div>
      }
    </div>
  `,
})
export class AcceptInviteComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private token = '';

  readonly loading = signal(true);
  readonly invite = signal<InviteView | null>(null);
  readonly step = signal<Step>('register');
  readonly settings = signal<OrgSettings | null>(null);

  passcode = '';
  displayName = '';
  email = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    this.token = this.route.snapshot.paramMap.get('token') ?? '';
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const view = await this.api.viewInvite(this.token);
      this.invite.set(view);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const user = await this.api.acceptInvite(this.token, {
        passcode: this.invite()!.requiresPasscode ? this.passcode : undefined,
        email: this.email,
        password: this.password,
        displayName: this.displayName,
      });
      this.auth.setUser(user);

      const [connections, cfg] = await Promise.all([
        this.api.listIntegrations().catch(() => [] as IntegrationConnection[]),
        this.api.getConfig().catch(() => null),
      ]);
      const activeConnection = connections.find(
        (c: IntegrationConnection) => c.provider === 'discord' && c.lifecycleState === 'active',
      );

      if (activeConnection && !user.hasDiscordLink) {
        this.settings.set(cfg);
        this.step.set('link-discord');
      } else {
        void this.router.navigate(['/home']);
      }
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  startDiscordLink(): void {
    // Full-page OAuth navigation; the callback links the account and returns to /account.
    this.busy.set(true);
    window.location.href = '/api/auth/discord/link';
  }

  skipDiscordLink(): void {
    void this.router.navigate(['/home']);
  }

  /** Full-page nav target for "Continue with Discord" registration. */
  discordRegisterUrl(): string {
    return `/api/auth/discord/register?invite=${encodeURIComponent(this.token)}`;
  }
}
