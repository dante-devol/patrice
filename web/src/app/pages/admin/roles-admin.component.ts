import { LoadingTableRowsComponent } from '../../shared/loading';
import { OrgApi } from '../../core/api/org.api';
import { IntegrationsApi } from '../../core/api/work.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Role, SyncDirection } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { SaveBarComponent } from './save-bar.component';
import { StagedRows } from './staged-rows';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

/** One role↔Discord-group mapping, flattened for display in the roles table. */
interface RoleMapping {
  connectionName: string;
  externalGroupId: string;
  syncDirection: SyncDirection;
  isBroken: boolean;
}

/** Role list/editor. New roles (org or unit), renames, leads-assignable and retire/revive are staged until Save. */
@Component({
  selector: 'roles-admin',
  standalone: true,
  imports: [FormsModule, SaveBarComponent, LoadingTableRowsComponent],
  styles: [`
    .map-chip {
      display: inline-flex; align-items: center; gap: 5px; font-size: 11px;
      border: 1px solid var(--border); border-radius: 2px; padding: 1px 8px;
      color: var(--ink-soft, var(--muted));
    }
    .map-chip + .map-chip { margin-left: 4px; }
    .map-chip.broken { border-color: var(--danger); color: var(--danger); }
    .map-chip .dir { font-weight: 600; }
  `],
  template: `
    <div class="panel">
      <h2>Roles</h2>
      <div class="row">
        <button class="secondary" (click)="rows.addCreate()">Add role</button>
      </div>
      @if (loadError()) { <p class="error">{{ loadError() }}</p> }
      <table [attr.aria-busy]="!loaded()">
        <thead><tr><th>Name</th><th>Kind</th><th>Integration</th><th>State</th><th></th></tr></thead>
        @if (!loaded()) {
          <tbody loadingRows [cols]="5" [rows]="5" label="Loading roles"></tbody>
        } @else {
        <tbody>
          @for (c of rows.creates(); track c.key) {
            <tr class="is-staged">
              <td><input [ngModel]="c.fields.name" (ngModelChange)="rows.updateCreate(c.key, 'name', $event)" placeholder="New role name" aria-label="Name" /></td>
              <td>
                <select [ngModel]="c.fields.kind" (ngModelChange)="rows.updateCreate(c.key, 'kind', $event)" aria-label="Role kind"
                        title="An org role applies wherever its grants say. A unit role is assigned at a division or team, and its grants apply only there.">
                  <option value="org">Org role</option>
                  <option value="unit">Unit role</option>
                </select>
                @if (c.fields.kind === 'unit') {
                  <label class="inline-flex items-center gap-1.5 ml-3" title="Leads at a division or team may assign this role there">
                    <input type="checkbox" [ngModel]="c.fields.assignableByLeads" (ngModelChange)="rows.updateCreate(c.key, 'assignableByLeads', $event)" /> Assignable by leads
                  </label>
                }
              </td>
              <td></td>
              <td><span class="staged-note">New, added on save</span></td>
              <td><button class="quiet" (click)="rows.removeCreate(c.key)">Remove</button></td>
            </tr>
          }
          @for (r of rows.saved(); track r.id) {
            @let lc = rows.lifecycleOf(r);
            <tr [class.row--retired]="r.lifecycleState === 'retired'" [class.is-staged]="rows.isChanged(r)" [class.is-retiring]="lc === 'retire'">
              <td>
                @if (r.lifecycleState === 'active') {
                  <input [class.is-changed]="rows.isChanged(r, 'name')" [ngModel]="rows.value(r, 'name')" (ngModelChange)="rows.set(r, 'name', $event)" aria-label="Name" />
                } @else { <span class="row-name">{{ r.name }}</span> }
              </td>
              <td>
                @if (r.kind === 'unit') {
                  Unit role
                  @if (r.lifecycleState === 'active') {
                    <label class="inline-flex items-center gap-1.5 ml-3" title="Leads at a division or team may assign this role there">
                      <input type="checkbox" [class.is-changed]="rows.isChanged(r, 'assignableByLeads')" [ngModel]="rows.value(r, 'assignableByLeads')" (ngModelChange)="rows.set(r, 'assignableByLeads', $event)" /> Assignable by leads
                    </label>
                  }
                } @else { <span class="muted">Org role</span> }
              </td>
              <td>
                @if (roleMappings(r.id); as maps) {
                  @if (maps.length === 0) {
                    <span class="muted">—</span>
                  } @else {
                    @for (m of maps; track m.externalGroupId) {
                      <span class="map-chip" [class.broken]="m.isBroken"
                            [title]="mapTitle(m)">
                        <span class="dir">{{ dirArrow(m.syncDirection) }}</span>
                        {{ short(m.externalGroupId) }}
                        @if (m.isBroken) { <span title="This mapping is broken — open Integrations to fix">⚠</span> }
                      </span>
                    }
                  }
                }
              </td>
              <td>
                @if (lc) { <span class="staged-note">{{ lc === 'retire' ? 'Retires on save' : 'Revives on save' }}</span> }
                @else { <span [class]="lcStamp(r.lifecycleState)">{{ r.lifecycleState }}</span> }
              </td>
              <td>
                @if (lc) {
                  <button class="quiet" (click)="rows.toggleLifecycle(r, lc)">Undo</button>
                } @else if (r.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="rows.toggleLifecycle(r, 'retire')">Retire</button>
                } @else if (r.lifecycleState === 'retired') {
                  <button class="quiet" (click)="rows.toggleLifecycle(r, 'revive')">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="5" class="muted">No roles.</td></tr> }
        </tbody>
        }
      </table>
    </div>
    <save-bar [count]="rows.count()" [where]="where()" [saving]="busy()" [error]="saveError()" [stale]="stale()"
              (save)="save()" (discard)="discard()" (reload)="reload()" />
  `,
})
export class RolesAdminComponent implements OnDestroy {
  private readonly integrationsApi = inject(IntegrationsApi);
  private readonly orgApi = inject(OrgApi);
  private readonly unsaved = inject(UnsavedChangesService);
  /** `kind` is picked when a role is added and fixed after; leads-assignable applies to unit roles only. */
  readonly rows = new StagedRows<Role, { name: string; kind: 'org' | 'unit'; assignableByLeads: boolean }>(
    (r) => ({ name: r.name, kind: r.kind, assignableByLeads: r.assignableByLeads }),
    () => ({ name: '', kind: 'org', assignableByLeads: false }),
  );
  readonly mappingsByRole = signal<Map<string, RoleMapping[]>>(new Map());
  readonly busy = signal(false);
  /** The first load has finished (or failed): until then the table shows placeholders. */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  readonly where = computed(() => {
    const names = this.rows.saved().filter((r) => this.rows.isChanged(r)).map((r) => r.name);
    const added = this.rows.creates().length;
    return [...names, ...(added ? [`${added} new`] : [])].join(', ') || null;
  });

  constructor() {
    effect(() => this.unsaved.pending.set(this.rows.count()));
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  private async load(discard: boolean): Promise<void> {
    try {
      const roles = await firstValueFrom(this.orgApi.listRoles(true));
      if (discard) this.rows.reset(roles);
      else this.rows.saved.set(roles);
      this.loadError.set(null);
      void this.loadMappings();
    } catch (e) {
      this.loadError.set(errorMessage(e));
    } finally {
      this.loaded.set(true);
    }
  }

  /**
   * Best-effort: index every active connection's role↔group mappings by Patrice role.
   * Integration reads are separately gated, so a role-manager without that grant just
   * sees no mapping column data (Permission Reflection — it degrades, never errors).
   */
  private async loadMappings(): Promise<void> {
    try {
      const conns = await firstValueFrom(this.integrationsApi.listIntegrations(false));
      const byRole = new Map<string, RoleMapping[]>();
      for (const c of conns) {
        const maps = await firstValueFrom(this.integrationsApi.listMappings(c.id)).catch(() => []);
        for (const m of maps) {
          if (!m.roleId) continue; // a membership mapping
          const list = byRole.get(m.roleId) ?? [];
          list.push({
            connectionName: c.displayName,
            externalGroupId: m.externalGroupId,
            syncDirection: m.syncDirection,
            isBroken: m.isBroken,
          });
          byRole.set(m.roleId, list);
        }
      }
      this.mappingsByRole.set(byRole);
    } catch {
      // No integration read access (or none configured) — leave the column blank.
    }
  }

  roleMappings(roleId: string): RoleMapping[] {
    return this.mappingsByRole().get(roleId) ?? [];
  }

  /** Direction as a glanceable arrow: ← from Discord, → to Discord, ↔ two-way. */
  dirArrow(dir: SyncDirection): string {
    return dir === 'inbound' ? '←' : dir === 'outbound' ? '→' : '↔';
  }

  private dirWord(dir: SyncDirection): string {
    return dir === 'inbound'
      ? 'from Discord (inbound)'
      : dir === 'outbound'
        ? 'to Discord (outbound)'
        : 'two-way (bidirectional)';
  }

  mapTitle(m: RoleMapping): string {
    return `${m.connectionName} · Discord role ${m.externalGroupId} · syncs ${this.dirWord(m.syncDirection)}${m.isBroken ? ' · BROKEN — fix in Integrations' : ''}`;
  }

  short(id: string): string {
    return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-2)}` : id;
  }

  lcStamp(state: string): string { return `stamp stamp--lc-${state}`; }

  discard(): void {
    this.rows.discard();
    this.saveError.set(null);
    this.stale.set(false);
  }

  async reload(): Promise<void> {
    this.saveError.set(null);
    this.stale.set(false);
    await this.load(true);
  }

  async save(): Promise<void> {
    const named = (n: string) => n.trim().length > 0;
    if (this.rows.creates().some((c) => !named(c.fields.name)) || Object.values(this.rows.edits()).some((e) => e.name !== undefined && !named(e.name))) {
      this.saveError.set('Every role needs a name.');
      return;
    }
    const ops: StagedOp[] = [
      ...this.rows.creates().map((c) => ({
        run: () => firstValueFrom(this.orgApi.createRole(c.fields.name.trim(), c.fields.kind, c.fields.assignableByLeads)),
        clear: () => this.rows.removeCreate(c.key),
      })),
      ...Object.entries(this.rows.edits()).map(([id, patch]) => ({
        run: () => {
          const r = this.rows.saved().find((x) => x.id === id)!;
          return firstValueFrom(this.orgApi.updateRole(id, {
            name: (patch.name ?? r.name).trim(),
            ...(r.kind === 'unit' && patch.assignableByLeads !== undefined ? { assignableByLeads: patch.assignableByLeads } : {}),
            version: r.version,
          }));
        },
        clear: () => this.rows.clearEdit(id),
      })),
      // Retiring a role can remove authority; the API refuses one that would leave no admin.
      ...Object.entries(this.rows.lifecycle()).map(([id, op]) => ({
        run: () => firstValueFrom(op === 'retire' ? this.orgApi.retireRole(id) : this.orgApi.reviveRole(id)),
        clear: () => this.rows.clearLifecycle(id),
      })),
    ];
    this.busy.set(true);
    this.saveError.set(null);
    this.stale.set(false);
    const result = await runStaged(ops);
    await this.load(false);
    if (result.error) {
      this.stale.set(isStale(result.error));
      this.saveError.set(stagedErrorMessage(result));
    } else {
      this.unsaved.markSaved();
    }
    this.busy.set(false);
  }
}
