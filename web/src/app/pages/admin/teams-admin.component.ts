import { OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Division, Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { teamColor as computeTeamColor } from '../tasks/task-presentation';

/** Teams editor: name, restrict-claims. Every team belongs to a division. */
@Component({
  selector: 'teams-admin',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel">
      <h2>Teams</h2>
      <div class="row">
        <input [(ngModel)]="newName" placeholder="New team name" />
        <select [(ngModel)]="newDivisionId" aria-label="Division">
          <option value="" disabled>Division…</option>
          @for (d of divisions(); track d.id) { <option [value]="d.id">{{ d.name }}</option> }
        </select>
        <button [disabled]="busy() || !newName.trim() || !newDivisionId" (click)="create()">Create team</button>
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>Name</th><th>Color</th><th>Restrict claims</th><th>State</th><th></th></tr></thead>
        <tbody>
          @for (t of teams(); track t.id) {
            <tr [class.row--retired]="t.lifecycleState === 'retired'" [class.row--deactivated]="t.lifecycleState === 'deactivated'">
              <td class="name-cell" [style.--c]="computeColor(t)"><input [(ngModel)]="t.name" (blur)="save(t, { name: t.name })" aria-label="Name" /></td>
              <td>
                <span [style.background]="computeColor(t)" title="Computed from the name"
                      style="display:inline-block;width:26px;height:20px;border-radius:3px"></span>
              </td>
              <td><input type="checkbox" [(ngModel)]="t.restrictClaims"
                         (change)="save(t, { restrictClaims: t.restrictClaims })" /></td>
              <td><span [class]="lcStamp(t.lifecycleState)">{{ t.lifecycleState }}</span></td>
              <td>
                <a class="quiet" [routerLink]="['/teams', t.id]">Open page</a>
                @if (t.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="retire(t)">Retire</button>
                } @else if (t.lifecycleState === 'retired') {
                  <button class="quiet" (click)="revive(t)">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="5" class="muted">No teams.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class TeamsAdminComponent {
  readonly orgApi = inject(OrgApi);
  readonly teams = signal<Team[]>([]);
  readonly divisions = signal<Division[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  newName = '';
  newDivisionId = '';

  lcStamp(state: string): string { return `stamp stamp--lc-${state}`; }
  computeColor(t: Team): string { return computeTeamColor(t.name); }


  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [teams, divisions] = await Promise.all([firstValueFrom(this.orgApi.listTeams(true)), firstValueFrom(this.orgApi.listDivisions())]);
      this.teams.set(teams);
      this.divisions.set(divisions);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.orgApi.createTeam({ name: this.newName.trim(), divisionId: this.newDivisionId }));
      this.newName = '';
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async save(t: Team, patch: Partial<Team>): Promise<void> {
    this.error.set(null);
    try {
      await firstValueFrom(this.orgApi.updateTeam(t.id, patch));
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }

  async retire(t: Team): Promise<void> {
    await this.guard(() => firstValueFrom(this.orgApi.retireTeam(t.id)));
  }
  async revive(t: Team): Promise<void> {
    await this.guard(() => firstValueFrom(this.orgApi.reviveTeam(t.id)));
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
