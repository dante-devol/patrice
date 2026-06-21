import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { Role } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** Standalone-role list/editor (Slice 2.1). Inherent roles are read-only here. */
@Component({
  selector: 'roles-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Roles</h2>
      <div class="row">
        <input [(ngModel)]="newName" placeholder="New role name" />
        <button [disabled]="busy() || !newName.trim()" (click)="create()">Create role</button>
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>State</th><th></th></tr></thead>
        <tbody>
          @for (r of roles(); track r.id) {
            <tr>
              <td>
                @if (r.kind === 'standalone' && r.lifecycleState === 'active') {
                  <input [(ngModel)]="r.name" (blur)="rename(r)" />
                } @else { {{ r.name }} }
              </td>
              <td><span class="badge">{{ r.kind }}</span></td>
              <td>{{ r.lifecycleState }}</td>
              <td>
                @if (r.kind === 'standalone') {
                  @if (r.lifecycleState === 'active') {
                    <button class="secondary" (click)="retire(r)">Retire</button>
                  } @else if (r.lifecycleState === 'retired') {
                    <button class="secondary" (click)="revive(r)">Revive</button>
                  }
                } @else {
                  <span class="muted">managed by {{ r.kind }}</span>
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
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  newName = '';

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.roles.set(await this.api.listRoles(true));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

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
      await this.api.updateRole(r.id, r.name);
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
