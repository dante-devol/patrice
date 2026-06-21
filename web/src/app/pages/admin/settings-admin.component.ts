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
        <label><input type="checkbox" [(ngModel)]="s.requireVerifiedEmailToLogIn" />
          Require a verified email to log in</label>
        <label><input type="checkbox" [(ngModel)]="s.selfReviewAllowed" />
          Allow self-review</label>
        <label><input type="checkbox" [(ngModel)]="s.anonymizeLabel" />
          Anonymize scrubbed users as "Former member"</label>
        <label>Session absolute lifetime (days)
          <input type="number" min="1" [(ngModel)]="s.sessionAbsoluteDays" /></label>
        <label>Session idle lifetime (days)
          <input type="number" min="1" [(ngModel)]="s.sessionIdleDays" /></label>
        <label>Retirement grace period (hours)
          <input type="number" min="0" [(ngModel)]="s.gracePeriodHours" /></label>
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
