import { AccessApi, OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminUser, Role } from '../../core/api.types';
import { LookupStore } from '../../core/lookup.store';
import { errorMessage } from '../../core/errors';
import { UserAvatarComponent } from '../tasks/user-avatar.component';
import { avatarColor, initials } from '../tasks/task-presentation';

type UnitRole = AdminUser['unitRoles'][number];

/**
 * Users list + per-user role-assignment panel. Org roles are granted org-wide; unit
 * roles are assigned at a division or team (through the unit's role-assignment
 * endpoints, which also add membership).
 */
@Component({
  selector: 'users-admin',
  standalone: true,
  imports: [FormsModule, UserAvatarComponent],
  template: `
    <div class="panel">
      <h2>Users</h2>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>User</th><th>Roles</th><th>Unit roles</th><th>State</th><th>Add role</th><th></th></tr></thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr [class.row--retired]="u.lifecycleState === 'retired'" [class.row--deactivated]="u.lifecycleState === 'deactivated'">
              <td>
                <div class="row" style="gap:10px;flex-wrap:nowrap;justify-content:flex-start">
                  <user-avatar [name]="u.displayName" [seed]="u.id" [size]="28" [imageUrl]="u.avatarUrl" />
                  <div>{{ u.displayName }}<br /><span class="muted">{{ u.email }}</span></div>
                </div>
              </td>
              <td>
                @for (rid of u.roleIds; track rid) {
                  <span class="badge">
                    {{ roleName(rid) }}
                    <a href="javascript:void(0)" (click)="revoke(u, rid)">×</a>
                  </span>
                } @empty { <span class="muted">none</span> }
              </td>
              <td>
                @for (a of u.unitRoles; track a.id) {
                  <span class="badge" [title]="unitLabel(a) + ' (' + (a.unitType === 'division' ? 'division, covers its teams' : 'team') + ')'">
                    {{ roleName(a.roleId) }} at {{ unitLabel(a) }}
                    <a href="javascript:void(0)" (click)="unassign(u, a)" [attr.aria-label]="'Remove ' + roleName(a.roleId) + ' at ' + unitLabel(a)">×</a>
                  </span>
                } @empty { <span class="muted">none</span> }
                @if (u.lifecycleState === 'active' && unitRoles().length) {
                  <div class="row" style="gap:6px;flex-wrap:nowrap;margin-top:6px">
                    <select #urole style="flex:1;min-width:0;margin:0" aria-label="Unit role">
                      <option value="">Unit role…</option>
                      @for (r of unitRoles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
                    </select>
                    <select #unit style="flex:1;min-width:0;margin:0" aria-label="Division or team">
                      <option value="">At…</option>
                      @for (d of lookup.divisionList(); track d.id) {
                        <optgroup [label]="d.name">
                          <option [value]="'division:' + d.id">{{ d.name }} (whole division)</option>
                          @for (t of teamsOf(d.id); track t.id) { <option [value]="'team:' + t.id">{{ t.name }}</option> }
                        </optgroup>
                      }
                    </select>
                    <button class="secondary" style="margin:0;white-space:nowrap"
                            (click)="assign(u, urole.value, unit.value); urole.value=''; unit.value=''">Assign</button>
                  </div>
                }
              </td>
              <td><span [class]="lcStamp(u.lifecycleState)">{{ u.lifecycleState }}</span></td>
              <td>
                <div class="row" style="gap:6px;flex-wrap:nowrap">
                  <select #sel style="flex:1;min-width:0;margin:0">
                    <option value="">Select role…</option>
                    @for (r of grantableRoles(u); track r.id) {
                      <option [value]="r.id">{{ r.name }}</option>
                    }
                  </select>
                  <button class="secondary" style="margin:0;white-space:nowrap" (click)="grant(u, sel.value); sel.value=''">Add</button>
                </div>
              </td>
              <td>
                @if (u.lifecycleState === 'active') {
                  <button class="quiet" (click)="deactivate(u)">Deactivate</button>
                  <button class="quiet danger" (click)="retire(u)">Retire</button>
                } @else if (u.lifecycleState === 'deactivated') {
                  <button class="quiet" (click)="reactivate(u)">Reactivate</button>
                  <button class="quiet danger" (click)="retire(u)">Retire</button>
                } @else if (u.lifecycleState === 'retired') {
                  <button class="quiet" (click)="revive(u)">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="6" class="muted">No users.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class UsersAdminComponent {
  readonly accessApi = inject(AccessApi);
  readonly orgApi = inject(OrgApi);
  readonly lookup = inject(LookupStore);
  readonly users = signal<AdminUser[]>([]);
  readonly roles = signal<Role[]>([]);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [users, roles] = await Promise.all([
        // Include retired users so scrubbed tombstones (rendered "Former member"
        // when anonymizeLabel is set) stay visible in the admin roster.
        firstValueFrom(this.accessApi.listUsers(true)),
        firstValueFrom(this.orgApi.listRoles()),
      ]);
      this.users.set(users);
      this.roles.set(roles);
      await this.lookup.ensureLoaded();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  lcStamp(state: string): string {
    return `stamp stamp--lc-${state}`;
  }

  roleName(id: string): string {
    return this.roles().find((r) => r.id === id)?.name ?? id.slice(0, 8);
  }

  /** Org roles only: unit roles are assigned at a division or team, not org-wide. */
  grantableRoles(u: AdminUser): Role[] {
    return this.roles().filter(
      (r) => r.kind === 'org' && r.lifecycleState === 'active' && !u.roleIds.includes(r.id),
    );
  }

  unitRoles(): Role[] {
    return this.roles().filter((r) => r.kind === 'unit' && r.lifecycleState === 'active');
  }

  teamsOf(divisionId: string) {
    return this.lookup.teamList().filter((t) => t.divisionId === divisionId);
  }

  unitLabel(a: UnitRole): string {
    if (a.unitType === 'division') return this.lookup.divisionName(a.unitId);
    const team = this.lookup.teamList().find((t) => t.id === a.unitId);
    return team ? `${team.name} (${this.lookup.divisionName(team.divisionId)})` : this.lookup.teamName(a.unitId);
  }

  /** `unit` is "division:<id>" or "team:<id>" from the picker. */
  async assign(u: AdminUser, roleId: string, unit: string): Promise<void> {
    const [unitType, unitId] = unit.split(':') as ['division' | 'team', string];
    if (!roleId || !unitId) {
      this.error.set('Pick a unit role and where it applies.');
      return;
    }
    await this.guard(() => firstValueFrom(this.orgApi.assignRole(unitType, unitId, u.id, roleId)));
  }
  async unassign(_u: AdminUser, a: UnitRole): Promise<void> {
    await this.guard(() => firstValueFrom(this.orgApi.unassignRole(a.unitType, a.unitId, a.id)));
  }

  async grant(u: AdminUser, roleId: string): Promise<void> {
    if (!roleId) return;
    await this.guard(() => firstValueFrom(this.accessApi.grantUserRole(u.id, roleId)));
  }
  async revoke(u: AdminUser, roleId: string): Promise<void> {
    await this.guard(() => firstValueFrom(this.accessApi.revokeUserRole(u.id, roleId)));
  }
  async deactivate(u: AdminUser): Promise<void> {
    await this.guard(() => firstValueFrom(this.accessApi.deactivateUser(u.id)));
  }
  async reactivate(u: AdminUser): Promise<void> {
    await this.guard(() => firstValueFrom(this.accessApi.reactivateUser(u.id)));
  }
  async retire(u: AdminUser): Promise<void> {
    await this.guard(() => firstValueFrom(this.accessApi.retireUser(u.id)));
  }
  async revive(u: AdminUser): Promise<void> {
    await this.guard(() => firstValueFrom(this.accessApi.reviveUser(u.id)));
  }

  async guard(fn: () => Promise<unknown>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
      await this.refresh();
    } catch (e) {
      // Surfaces the LAST_ADMIN refusal (and any 403 scope refusal) inline.
      this.error.set(errorMessage(e));
    }
  }
}
