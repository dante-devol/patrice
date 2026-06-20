import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { Division, Grant, Role, ScopeKind, Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** Id-less scope shapes, editable directly in a grid cell. */
const CELL_SCOPES: ScopeKind[] = ['global', 'own_division', 'own_team', 'own'];

/**
 * Permission Matrix editor (Slice 2.3): a role × action grid. Each cell carries a
 * scope picker for the id-less Scope Shapes (global / own_division / own_team /
 * own); targeted shapes (specific_division/team, role) are authored via the form
 * below, which also surfaces the API's validate-before-activate refusals inline.
 */
@Component({
  selector: 'matrix-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Permission Matrix</h2>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <div style="overflow:auto; max-height:60vh">
        <table>
          <thead>
            <tr>
              <th>Action \\ Role</th>
              @for (r of activeRoles(); track r.id) { <th>{{ r.name }}</th> }
            </tr>
          </thead>
          <tbody>
            @for (a of actions(); track a) {
              <tr>
                <td><code>{{ a }}</code></td>
                @for (r of activeRoles(); track r.id) {
                  <td>
                    <select [ngModel]="cellScope(r.id, a)"
                            (ngModelChange)="setCell(r.id, a, $event)">
                      <option value="">—</option>
                      @for (s of cellScopes; track s) { <option [value]="s">{{ s }}</option> }
                      @if (isTargeted(r.id, a)) {
                        <option [value]="targetedScope(r.id, a)" disabled>
                          {{ targetedScope(r.id, a) }} (form)
                        </option>
                      }
                    </select>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h3>Add a targeted grant</h3>
      <div class="row">
        <select [(ngModel)]="formRole">
          <option value="">Role…</option>
          @for (r of activeRoles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
        </select>
        <select [(ngModel)]="formAction">
          <option value="">Action…</option>
          @for (a of actions(); track a) { <option [value]="a">{{ a }}</option> }
        </select>
        <select [(ngModel)]="formScope">
          <option value="specific_division">specific_division</option>
          <option value="specific_team">specific_team</option>
          <option value="role">role</option>
        </select>
        @if (formScope === 'specific_division') {
          <select [(ngModel)]="formDivision">
            <option value="">Division…</option>
            @for (d of divisions(); track d.id) { <option [value]="d.id">{{ d.name }}</option> }
          </select>
        }
        @if (formScope === 'specific_team') {
          <select [(ngModel)]="formTeam">
            <option value="">Team…</option>
            @for (t of teams(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }
          </select>
        }
        @if (formScope === 'role') {
          <select [(ngModel)]="formScopeRole">
            <option value="">Target role…</option>
            @for (r of activeRoles(); track r.id) { <option [value]="r.id">{{ r.name }}</option> }
          </select>
        }
        <button (click)="addTargeted()">Add grant</button>
      </div>
    </div>
  `,
})
export class MatrixAdminComponent {
  readonly api = inject(ApiService);
  readonly cellScopes = CELL_SCOPES;

  readonly roles = signal<Role[]>([]);
  readonly grants = signal<Grant[]>([]);
  readonly actions = signal<string[]>([]);
  readonly divisions = signal<Division[]>([]);
  readonly teams = signal<Team[]>([]);
  readonly error = signal<string | null>(null);

  readonly activeRoles = computed(() =>
    this.roles().filter((r) => r.lifecycleState === 'active'),
  );

  formRole = '';
  formAction = '';
  formScope: ScopeKind = 'specific_division';
  formDivision = '';
  formTeam = '';
  formScopeRole = '';

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [roles, grants, actions, divisions, teams] = await Promise.all([
        this.api.listRoles(),
        this.api.listGrants(),
        this.api.listActions(),
        this.api.listDivisions(),
        this.api.listTeams(),
      ]);
      this.roles.set(roles);
      this.grants.set(grants.filter((g) => g.lifecycleState === 'active'));
      this.actions.set(actions.actions);
      this.divisions.set(divisions);
      this.teams.set(teams);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  private cellGrant(roleId: string, action: string): Grant | undefined {
    return this.grants().find((g) => g.roleId === roleId && g.action === action);
  }
  cellScope(roleId: string, action: string): string {
    return this.cellGrant(roleId, action)?.scopeKind ?? '';
  }
  isTargeted(roleId: string, action: string): boolean {
    const s = this.cellGrant(roleId, action)?.scopeKind;
    return s === 'specific_division' || s === 'specific_team' || s === 'role';
  }
  targetedScope(roleId: string, action: string): string {
    return this.cellGrant(roleId, action)?.scopeKind ?? '';
  }

  /** Set/clear an id-less scope for a cell (retire-then-create, or just retire). */
  async setCell(roleId: string, action: string, scope: string): Promise<void> {
    this.error.set(null);
    const existing = this.cellGrant(roleId, action);
    try {
      if (existing) await this.api.retireGrant(existing.id);
      if (scope) {
        await this.api.createGrant({ roleId, action, scopeKind: scope as ScopeKind });
      }
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }

  async addTargeted(): Promise<void> {
    this.error.set(null);
    if (!this.formRole || !this.formAction) {
      this.error.set('Pick a role and an action.');
      return;
    }
    try {
      await this.api.createGrant({
        roleId: this.formRole,
        action: this.formAction,
        scopeKind: this.formScope,
        scopeDivisionId: this.formScope === 'specific_division' ? this.formDivision : undefined,
        scopeTeamId: this.formScope === 'specific_team' ? this.formTeam : undefined,
        scopeRoleId: this.formScope === 'role' ? this.formScopeRole : undefined,
      });
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
