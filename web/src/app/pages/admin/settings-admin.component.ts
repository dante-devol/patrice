import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { ConfigUpdate, OrgSettings } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** Structured organization.settings editor (Slice 2.4) — not a JSON textarea. */
@Component({
  selector: 'settings-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Organization settings</h2>
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (saved()) { <p class="muted">Saved.</p> }
      @if (settings(); as s) {
        <div class="settings-group">
          <div class="settings-group-label">Security</div>
          <label><input type="checkbox" [(ngModel)]="s.requireVerifiedEmailToLogIn" />
            Require a verified email to log in</label>
          <label><input type="checkbox" [(ngModel)]="s.selfReviewAllowed" />
            Allow self-review (submitters may review their own work)</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Member records</div>
          <label><input type="checkbox" [(ngModel)]="s.anonymizeLabel" />
            Show retired members as "Former member" in task history</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Sessions</div>
          <label>Absolute session lifetime (days)
            <input type="number" min="1" [(ngModel)]="s.sessionAbsoluteDays" /></label>
          <label>Idle session lifetime (days) — sign out after this many days without activity
            <input type="number" min="1" [(ngModel)]="s.sessionIdleDays" /></label>
          <label>Retirement grace period (hours) — data is retained for this long before final scrub
            <input type="number" min="0" [(ngModel)]="s.gracePeriodHours" /></label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Integrations</div>
          <label><input type="checkbox" [(ngModel)]="s.requireDiscordLink" />
            Require Discord account link before accessing tasks</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Discord sign-in (OAuth app)</div>
          <p class="muted" style="font-size:12.5px;margin:0 0 6px">
            From your Discord application's OAuth2 settings. The redirect URI to register there
            is <code>{{ callbackUri }}</code>. The secret is encrypted and never shown again.
          </p>
          <label>Client ID
            <input [(ngModel)]="s.discordClientId" placeholder="application client id"
                   autocomplete="off" style="font-family:monospace" /></label>
          <label>Client secret
            <input type="password" [(ngModel)]="newSecret"
                   [placeholder]="s.discordOAuthConfigured ? '•••••••• (set — leave blank to keep)' : 'not set'"
                   autocomplete="off" style="font-family:monospace" /></label>
          @if (s.discordOAuthConfigured) {
            <label style="font-weight:normal"><input type="checkbox" [(ngModel)]="clearSecret" />
              Remove the stored secret (disables Discord sign-in)</label>
          }
        </div>
        <button [disabled]="busy()" (click)="save(s)">Save settings</button>
      }
    </div>
  `,
})
export class SettingsAdminComponent {
  private readonly api = inject(ApiService);
  readonly settings = signal<OrgSettings | null>(null);
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);

  /** Write-only secret entry (never populated from the server). */
  newSecret = '';
  clearSecret = false;
  readonly callbackUri = `${window.location.origin}/api/auth/discord/callback`;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.settings.set(await this.api.getConfig());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async save(s: OrgSettings): Promise<void> {
    this.busy.set(true);
    this.saved.set(false);
    this.error.set(null);
    // Build an explicit payload — the read-only `discordOAuthConfigured` must not be
    // sent (the API schema is strict), and the secret is sent only when set/cleared.
    const body: ConfigUpdate = {
      requireVerifiedEmailToLogIn: s.requireVerifiedEmailToLogIn,
      selfReviewAllowed: s.selfReviewAllowed,
      anonymizeLabel: s.anonymizeLabel,
      sessionAbsoluteDays: s.sessionAbsoluteDays,
      sessionIdleDays: s.sessionIdleDays,
      gracePeriodHours: s.gracePeriodHours,
      requireDiscordLink: s.requireDiscordLink,
      discordClientId: s.discordClientId ?? '',
    };
    if (this.clearSecret) body.discordClientSecret = '';
    else if (this.newSecret.trim()) body.discordClientSecret = this.newSecret.trim();
    try {
      this.settings.set(await this.api.updateConfig(body));
      this.newSecret = '';
      this.clearSecret = false;
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
