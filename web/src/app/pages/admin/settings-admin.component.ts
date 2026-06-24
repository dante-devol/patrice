import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { OrgSettings } from '../../core/api.types';
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
    try {
      this.settings.set(await this.api.updateConfig(s));
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
