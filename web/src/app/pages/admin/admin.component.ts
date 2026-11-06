import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { AdminPresenceStore, HEARTBEAT_MS } from '../../core/admin-presence.store';
import { AdminPage } from '../../core/api.types';
import { RolesAdminComponent } from './roles-admin.component';
import { DivisionsAdminComponent } from './divisions-admin.component';
import { TeamsAdminComponent } from './teams-admin.component';
import { UsersAdminComponent } from './users-admin.component';
import { PermissionsAdminComponent } from './permissions-admin.component';
import { SettingsAdminComponent } from './settings-admin.component';
import { ActivityAdminComponent } from './activity-admin.component';
import { InvitationsComponent } from '../invitations.component';
import { IntegrationsAdminComponent } from './integrations-admin.component';

type Tab =
  | 'roles'
  | 'divisions'
  | 'teams'
  | 'users'
  | 'permissions'
  | 'settings'
  | 'activity'
  | 'invitations'
  | 'integrations';

/** The tabs whose editors stage changes, and so announce and receive presence. */
const EDITOR_TABS: readonly Tab[] = ['roles', 'divisions', 'teams', 'users', 'permissions', 'settings', 'integrations'];

/** "Alex", "Alex and Sam", "Alex, Sam and Kim". */
function names(list: { displayName: string }[]): string {
  const n = [...new Set(list.map((e) => e.displayName))];
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/**
 * Admin-area shell: tabs over the editors. Every editor stages its changes until Save;
 * the shell turns the open tab's unsaved count into presence for the other admins on
 * that page, and shows theirs in a bar above the editor.
 */
@Component({
  standalone: true,
  imports: [
    RolesAdminComponent,
    DivisionsAdminComponent,
    TeamsAdminComponent,
    UsersAdminComponent,
    PermissionsAdminComponent,
    SettingsAdminComponent,
    ActivityAdminComponent,
    InvitationsComponent,
    IntegrationsAdminComponent,
  ],
  styles: [`
    .presence { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 12px; padding: 8px 12px;
                background: var(--paper); border: 1px solid #a9810f; border-radius: 2px; color: #7a5b00; font-size: 13px; }
    .presence b { font-weight: 700; }
  `],
  template: `
    <nav class="admin-tabs">
      @for (t of tabs; track t) {
        <button class="admin-tab" [class.is-active]="tab() === t" (click)="select(t)">{{ t }}</button>
      }
    </nav>
    @let p = presence();
    @if (p.editing.length > 0 || p.saved.length > 0) {
      <div class="presence" role="status">
        @if (p.editing.length > 0) {
          <span><b>{{ names(p.editing) }}</b> {{ p.editing.length === 1 ? 'is' : 'are' }} changing this page.</span>
        }
        @if (p.saved.length > 0) {
          <span><b>{{ names(p.saved) }}</b> saved changes to this page. Reload to see them.</span>
          <span class="flex-1"></span>
          <button class="quiet" (click)="reload()">Reload</button>
          <button class="quiet" (click)="dismissSaved()" aria-label="Dismiss">Dismiss</button>
        }
      </div>
    }
    <!-- Keyed on reloadKey so Reload remounts the editor and it reads fresh data. -->
    @for (k of [reloadKey()]; track k) {
      @switch (tab()) {
        @case ('roles') { <roles-admin /> }
        @case ('divisions') { <divisions-admin /> }
        @case ('teams') { <teams-admin /> }
        @case ('users') { <users-admin /> }
        @case ('permissions') { <permissions-admin /> }
        @case ('settings') { <settings-admin /> }
        @case ('activity') { <activity-admin /> }
        @case ('invitations') { <invitations-admin /> }
        @case ('integrations') { <integrations-admin /> }
      }
    }
  `,
})
export class AdminComponent {
  readonly tabs: Tab[] = [
    'roles',
    'divisions',
    'teams',
    'users',
    'permissions',
    'settings',
    'activity',
    'invitations',
    'integrations',
  ];
  readonly tab = signal<Tab>('roles');
  readonly reloadKey = signal(0);
  readonly names = names;
  private readonly unsaved = inject(UnsavedChangesService);
  private readonly presenceStore = inject(AdminPresenceStore);

  private readonly page = computed<AdminPage | null>(() =>
    EDITOR_TABS.includes(this.tab()) ? (this.tab() as AdminPage) : null,
  );
  readonly presence = computed(() => {
    const page = this.page();
    return page ? this.presenceStore.forPage()(page) : { editing: [], saved: [] };
  });

  /** The page this admin last announced as `editing`, and the heartbeat repeating it. */
  private announced: AdminPage | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSavedCount = this.unsaved.savedCount();

  constructor() {
    effect(() => {
      const page = this.page();
      const editing = this.unsaved.pending() > 0;
      const savedCount = this.unsaved.savedCount();
      untracked(() => this.announce(page, editing, savedCount));
    });
    inject(DestroyRef).onDestroy(() => this.announce(null, false, this.lastSavedCount));
  }

  /** Report transitions only: start/stop editing, a save, or a tab change. */
  private announce(page: AdminPage | null, editing: boolean, savedCount: number): void {
    const saved = savedCount !== this.lastSavedCount;
    this.lastSavedCount = savedCount;
    if (this.announced && (this.announced !== page || !editing)) {
      void this.presenceStore.report(this.announced, saved && this.announced === page ? 'saved' : 'idle');
      this.stopHeartbeat();
      this.announced = null;
    } else if (saved && page && !editing) {
      void this.presenceStore.report(page, 'saved');
    }
    if (page && editing && this.announced !== page) {
      this.announced = page;
      void this.presenceStore.report(page, 'editing');
      this.heartbeat = setInterval(() => void this.presenceStore.report(page, 'editing'), HEARTBEAT_MS);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Switching tabs unmounts the editor, so staged edits need a yes first. */
  select(t: Tab): void {
    if (t !== this.tab() && this.unsaved.confirmLeave()) this.tab.set(t);
  }

  /** Remount the editor so it reads what the other admin saved. */
  reload(): void {
    if (!this.unsaved.confirmLeave()) return;
    this.dismissSaved();
    this.reloadKey.update((k) => k + 1);
  }

  dismissSaved(): void {
    const page = this.page();
    if (page) this.presenceStore.clearSaved(page);
  }
}
