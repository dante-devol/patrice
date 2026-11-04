import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { Role, SyncDirection } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** One role↔Discord-group mapping, flattened for display in the roles table. */
interface RoleMapping {
  connectionName: string;
  externalGroupId: string;
  syncDirection: SyncDirection;
  isBroken: boolean;
}

/** Standalone-role list/editor (Slice 2.1). Inherent roles are read-only here. */
@Component({
  selector: 'roles-admin',
  standalone: true,
  imports: [FormsModule],
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
        <input [(ngModel)]="newName" placeholder="New role name" />
        <button [disabled]="busy() || !newName.trim()" (click)="create()">Create role</button>
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>Name</th><th>Integration</th><th>State</th><th></th></tr></thead>
        <tbody>
          @for (r of roles(); track r.id) {
            <tr [class.row--retired]="r.lifecycleState === 'retired'" [class.row--deactivated]="r.lifecycleState === 'deactivated'">
              <td>
                @if (r.lifecycleState === 'active') {
                  <input [(ngModel)]="r.name" (blur)="rename(r)" />
                } @else { {{ r.name }} }
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
              <td><span [class]="lcStamp(r.lifecycleState)">{{ r.lifecycleState }}</span></td>
              <td>
                @if (r.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="retire(r)">Retire</button>
                } @else if (r.lifecycleState === 'retired') {
                  <button class="quiet" (click)="revive(r)">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="4" class="muted">No roles.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class RolesAdminComponent {
  private readonly api = inject(ApiService);
  readonly roles = signal<Role[]>([]);
  readonly mappingsByRole = signal<Map<string, RoleMapping[]>>(new Map());
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  newName = '';

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.roles.set(await this.api.listRoles(true));
      void this.loadMappings();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /**
   * Best-effort: index every active connection's role↔group mappings by Patrice role.
   * Integration reads are separately gated, so a role-manager without that grant just
   * sees no mapping column data (Permission Reflection — it degrades, never errors).
   */
  private async loadMappings(): Promise<void> {
    try {
      const conns = await this.api.listIntegrations(false);
      const byRole = new Map<string, RoleMapping[]>();
      for (const c of conns) {
        const maps = await this.api.listMappings(c.id).catch(() => []);
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

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createRole(this.newName.trim());
      this.newName = '';
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async rename(r: Role): Promise<void> {
    this.error.set(null);
    try {
      await this.api.updateRole(r.id, { name: r.name });
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }


  async retire(r: Role): Promise<void> {
    await this.guard(() => this.api.retireRole(r.id));
  }
  async revive(r: Role): Promise<void> {
    await this.guard(() => this.api.reviveRole(r.id));
  }

  private async guard(fn: () => Promise<unknown>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
