import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AdminUser, Role } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** Users list + per-user role-assignment panel (Slice 2.4). */
@Component({
  selector: 'users-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Users</h2>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>User</th><th>Roles</th><th>State</th><th>Add role</th><th></th></tr></thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr>
              <td>{{ u.displayName }}<br /><span class="muted">{{ u.email }}</span></td>
              <td>
                @for (rid of u.roleIds; track rid) {
                  <span class="badge">
                    {{ roleName(rid) }}
                    <a href="javascript:void(0)" (click)="revoke(u, rid)">×</a>
                  </span>
                } @empty { <span class="muted">none</span> }
              </td>
              <td>{{ u.lifecycleState }}</td>
              <td>
                <select #sel>
                  <option value="">Select role…</option>
                  @for (r of grantableRoles(u); track r.id) {
                    <option [value]="r.id">{{ r.name }}</option>
                  }
                </select>
                <button class="secondary" (click)="grant(u, sel.value); sel.value=''">Add</button>
              </td>
              <td>
                @if (u.lifecycleState === 'active') {
                  <button class="secondary" (click)="deactivate(u)">Deactivate</button>
                  <button class="secondary" (click)="retire(u)">Retire</button>
                } @else if (u.lifecycleState === 'deactivated') {
                  <button class="secondary" (click)="reactivate(u)">Reactivate</button>
                  <button class="secondary" (click)="retire(u)">Retire</button>
                } @else if (u.lifecycleState === 'retired') {
                  <button class="secondary" (click)="revive(u)">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="5" class="muted">No users.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class UsersAdminComponent {
  readonly api = inject(ApiService);
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
        this.api.listUsers(true),
        this.api.listRoles(),
      ]);
      this.users.set(users);
      this.roles.set(roles);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  roleName(id: string): string {
    return this.roles().find((r) => r.id === id)?.name ?? id.slice(0, 8);
  }

  grantableRoles(u: AdminUser): Role[] {
    return this.roles().filter(
      (r) => r.lifecycleState === 'active' && !u.roleIds.includes(r.id),
    );
  }

  async grant(u: AdminUser, roleId: string): Promise<void> {
    if (!roleId) return;
    await this.guard(() => this.api.grantUserRole(u.id, roleId));
  }
  async revoke(u: AdminUser, roleId: string): Promise<void> {
    await this.guard(() => this.api.revokeUserRole(u.id, roleId));
  }
  async deactivate(u: AdminUser): Promise<void> {
    await this.guard(() => this.api.deactivateUser(u.id));
  }
  async reactivate(u: AdminUser): Promise<void> {
    await this.guard(() => this.api.reactivateUser(u.id));
  }
  async retire(u: AdminUser): Promise<void> {
    await this.guard(() => this.api.retireUser(u.id));
  }
  async revive(u: AdminUser): Promise<void> {
    await this.guard(() => this.api.reviveUser(u.id));
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
