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
  private connectionId: string | null = null;

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
        this.connectionId = activeConnection.id;
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

  async startDiscordLink(): Promise<void> {
    if (!this.connectionId) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const { redirectUrl } = await this.api.startDiscordLink(this.connectionId);
      window.location.href = redirectUrl;
    } catch (e) {
      this.error.set(errorMessage(e));
      this.busy.set(false);
    }
  }

  skipDiscordLink(): void {
    void this.router.navigate(['/home']);
  }
}
