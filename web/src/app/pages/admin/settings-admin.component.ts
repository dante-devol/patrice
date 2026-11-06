import { AdminApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfigUpdate, OrgSettings } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { SaveBarComponent } from './save-bar.component';
import { isStale } from './staged';

/** The settings an admin edits here (everything but the write-only secret). */
type Editable = Omit<OrgSettings, 'discordOAuthConfigured'>;
type Field = keyof Editable;

const FIELDS: Field[] = [
  'requireVerifiedEmailToLogIn',
  'selfReviewAllowed',
  'anonymizeLabel',
  'sessionAbsoluteDays',
  'sessionIdleDays',
  'gracePeriodHours',
  'requireDiscordLink',
  'discordClientId',
];

/**
 * Structured organization settings. Edits are staged until Save, which sends only the
 * changed fields together with the values they replace, so another admin's change to
 * the same setting in the meantime is refused rather than overwritten.
 */
@Component({
  selector: 'settings-admin',
  standalone: true,
  imports: [FormsModule, SaveBarComponent],
  styles: [`.is-changed { box-shadow: inset 3px 0 0 var(--rust); padding-left: 8px; }`],
  template: `
    <div class="panel">
      <h2>Organization settings</h2>
      @if (loadError()) { <p class="error">{{ loadError() }}</p> }
      @if (draft(); as s) {
        <div class="settings-group">
          <div class="settings-group-label">Security</div>
          <label [class.is-changed]="changed('requireVerifiedEmailToLogIn')"><input type="checkbox" [ngModel]="s.requireVerifiedEmailToLogIn" (ngModelChange)="set('requireVerifiedEmailToLogIn', $event)" />
            Require a verified email to log in</label>
          <label [class.is-changed]="changed('selfReviewAllowed')"><input type="checkbox" [ngModel]="s.selfReviewAllowed" (ngModelChange)="set('selfReviewAllowed', $event)" />
            Allow self-review (submitters may review their own work)</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Member records</div>
          <label [class.is-changed]="changed('anonymizeLabel')"><input type="checkbox" [ngModel]="s.anonymizeLabel" (ngModelChange)="set('anonymizeLabel', $event)" />
            Show retired members as "Former member" in task history</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Sessions</div>
          <label [class.is-changed]="changed('sessionAbsoluteDays')">Absolute session lifetime (days)
            <input type="number" min="1" [ngModel]="s.sessionAbsoluteDays" (ngModelChange)="set('sessionAbsoluteDays', +$event)" /></label>
          <label [class.is-changed]="changed('sessionIdleDays')">Idle session lifetime (days): sign out after this many days without activity
            <input type="number" min="1" [ngModel]="s.sessionIdleDays" (ngModelChange)="set('sessionIdleDays', +$event)" /></label>
          <label [class.is-changed]="changed('gracePeriodHours')">Retirement grace period (hours): data is kept this long before the final scrub
            <input type="number" min="0" [ngModel]="s.gracePeriodHours" (ngModelChange)="set('gracePeriodHours', +$event)" /></label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Integrations</div>
          <label [class.is-changed]="changed('requireDiscordLink')"><input type="checkbox" [ngModel]="s.requireDiscordLink" (ngModelChange)="set('requireDiscordLink', $event)" />
            Require Discord account link before accessing tasks</label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Discord sign-in (OAuth app)</div>
          <p class="muted" style="font-size:12.5px;margin:0 0 6px">
            From your Discord application's OAuth2 settings. The redirect URI to register there
            is <code>{{ callbackUri }}</code>. The secret is encrypted and never shown again.
          </p>
          <label [class.is-changed]="changed('discordClientId')">Client ID
            <input [ngModel]="s.discordClientId ?? ''" (ngModelChange)="set('discordClientId', $event)" placeholder="application client id"
                   autocomplete="off" style="font-family:monospace" /></label>
          <label [class.is-changed]="!!newSecret()">Client secret
            <input type="password" [ngModel]="newSecret()" (ngModelChange)="newSecret.set($event)"
                   [placeholder]="configured() ? '•••••••• (set, leave blank to keep)' : 'not set'"
                   autocomplete="off" style="font-family:monospace" /></label>
          @if (configured()) {
            <label style="font-weight:normal" [class.is-changed]="clearSecret()"><input type="checkbox" [ngModel]="clearSecret()" (ngModelChange)="clearSecret.set($event)" />
              Remove the stored secret (disables Discord sign-in)</label>
          }
        </div>
      }
    </div>
    <save-bar [count]="count()" [saving]="busy()" [error]="saveError()" [stale]="stale()"
              (save)="save()" (discard)="discard()" (reload)="reload()" />
  `,
})
export class SettingsAdminComponent implements OnDestroy {
  private readonly adminApi = inject(AdminApi);
  private readonly unsaved = inject(UnsavedChangesService);
  private readonly saved = signal<OrgSettings | null>(null);
  readonly draft = signal<Editable | null>(null);
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  /** Write-only secret entry (never populated from the server). */
  readonly newSecret = signal('');
  readonly clearSecret = signal(false);
  readonly callbackUri = `${window.location.origin}/api/auth/discord/callback`;
  readonly configured = computed(() => this.saved()?.discordOAuthConfigured ?? false);

  private readonly changedFields = computed(() => {
    const s = this.saved();
    const d = this.draft();
    if (!s || !d) return [] as Field[];
    return FIELDS.filter((k) => (d[k] ?? null) !== (s[k] ?? null) && !(k === 'discordClientId' && !d[k] && !s[k]));
  });
  readonly count = computed(
    () => this.changedFields().length + (this.newSecret().trim() ? 1 : 0) + (this.clearSecret() ? 1 : 0),
  );

  constructor() {
    effect(() => this.unsaved.pending.set(this.count()));
    void this.load();
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  private async load(): Promise<void> {
    try {
      this.setSaved(await firstValueFrom(this.adminApi.getConfig()));
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }

  private setSaved(s: OrgSettings): void {
    this.saved.set(s);
    const { discordOAuthConfigured: _c, ...editable } = s;
    this.draft.set(editable);
    this.newSecret.set('');
    this.clearSecret.set(false);
  }

  changed(k: Field): boolean {
    return this.changedFields().includes(k);
  }

  set<K extends Field>(k: K, v: Editable[K]): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, [k]: v });
    this.saveError.set(null);
  }

  discard(): void {
    const s = this.saved();
    if (s) this.setSaved(s);
    this.saveError.set(null);
    this.stale.set(false);
  }

  async reload(): Promise<void> {
    this.saveError.set(null);
    this.stale.set(false);
    await this.load();
  }

  async save(): Promise<void> {
    const s = this.saved();
    const d = this.draft();
    if (!s || !d) return;
    const body: ConfigUpdate = { expected: {} };
    for (const k of this.changedFields()) {
      (body as Record<string, unknown>)[k] = k === 'discordClientId' ? (d[k] ?? '') : d[k];
      (body.expected as Record<string, unknown>)[k] = s[k];
    }
    if (this.clearSecret()) body.discordClientSecret = '';
    else if (this.newSecret().trim()) body.discordClientSecret = this.newSecret().trim();

    this.busy.set(true);
    this.saveError.set(null);
    this.stale.set(false);
    try {
      this.setSaved(await firstValueFrom(this.adminApi.updateConfig(body)));
      this.unsaved.markSaved();
    } catch (e) {
      this.stale.set(isStale(e));
      this.saveError.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
