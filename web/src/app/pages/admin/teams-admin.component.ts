import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/** Teams editor (Slice 2.2): name, restrict-claims. */
@Component({
  selector: 'teams-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="panel">
      <h2>Teams</h2>
      <div class="row">
        <input [(ngModel)]="newName" placeholder="New team name" />
        <button [disabled]="busy() || !newName.trim()" (click)="create()">Create team</button>
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead><tr><th>Name</th><th>Restrict claims</th><th>State</th><th></th></tr></thead>
        <tbody>
          @for (t of teams(); track t.id) {
            <tr>
              <td><input [(ngModel)]="t.name" (blur)="save(t, { name: t.name })" /></td>
              <td><input type="checkbox" [(ngModel)]="t.restrictClaims"
                         (change)="save(t, { restrictClaims: t.restrictClaims })" /></td>
              <td>{{ t.lifecycleState }}</td>
              <td>
                @if (t.lifecycleState === 'active') {
                  <button class="secondary" (click)="retire(t)">Retire</button>
                } @else if (t.lifecycleState === 'retired') {
                  <button class="secondary" (click)="revive(t)">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="4" class="muted">No teams.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class TeamsAdminComponent {
  readonly api = inject(ApiService);
  readonly teams = signal<Team[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  newName = '';

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.teams.set(await this.api.listTeams(true));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createTeam({ name: this.newName.trim() });
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
      await this.api.updateTeam(t.id, patch);
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }

  async retire(t: Team): Promise<void> {
    await this.guard(() => this.api.retireTeam(t.id));
  }
  async revive(t: Team): Promise<void> {
    await this.guard(() => this.api.reviveTeam(t.id));
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
