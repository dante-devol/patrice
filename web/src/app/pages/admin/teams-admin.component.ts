import { OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Division, Team } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { teamColor as computeTeamColor } from '../tasks/task-presentation';
import { SaveBarComponent } from './save-bar.component';
import { StagedRows } from './staged-rows';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

interface Fields {
  name: string;
  restrictClaims: boolean;
  /** Chosen when the team is created, fixed after. */
  divisionId: string;
}

/**
 * Teams editor: name, restrict-claims, retire/revive. Every team belongs to a division,
 * picked when it's added. Every change, new teams included, is staged until Save.
 */
@Component({
  selector: 'teams-admin',
  standalone: true,
  imports: [FormsModule, RouterLink, SaveBarComponent],
  template: `
    <div class="panel">
      <h2>Teams</h2>
      <div class="row">
        <button class="secondary" (click)="rows.addCreate()">Add team</button>
      </div>
      @if (loadError()) { <p class="error">{{ loadError() }}</p> }
      <table>
        <thead><tr><th>Name</th><th>Division</th><th>Color</th><th>Restrict claims</th><th>State</th><th></th></tr></thead>
        <tbody>
          @for (c of rows.creates(); track c.key) {
            <tr class="is-staged">
              <td><input [ngModel]="c.fields.name" (ngModelChange)="rows.updateCreate(c.key, 'name', $event)" placeholder="New team name" aria-label="Name" /></td>
              <td>
                <select [ngModel]="c.fields.divisionId" (ngModelChange)="rows.updateCreate(c.key, 'divisionId', $event)" aria-label="Division">
                  <option value="" disabled>Division…</option>
                  @for (d of divisions(); track d.id) { <option [value]="d.id">{{ d.name }}</option> }
                </select>
              </td>
              <td></td>
              <td><input type="checkbox" [ngModel]="c.fields.restrictClaims" (ngModelChange)="rows.updateCreate(c.key, 'restrictClaims', $event)" aria-label="Restrict claims" /></td>
              <td><span class="staged-note">New, added on save</span></td>
              <td><button class="quiet" (click)="rows.removeCreate(c.key)">Remove</button></td>
            </tr>
          }
          @for (t of rows.saved(); track t.id) {
            @let lc = rows.lifecycleOf(t);
            <tr [class.row--retired]="t.lifecycleState === 'retired'" [class.is-staged]="rows.isChanged(t)" [class.is-retiring]="lc === 'retire'">
              <td class="name-cell" [style.--c]="computeColor(t)">
                <input [class.is-changed]="rows.isChanged(t, 'name')" [ngModel]="rows.value(t, 'name')" (ngModelChange)="rows.set(t, 'name', $event)" aria-label="Name" />
              </td>
              <td>{{ divisionName(t.divisionId) }}</td>
              <td>
                <span [style.background]="computeColor(t)" title="Computed from the name"
                      style="display:inline-block;width:26px;height:20px;border-radius:2px"></span>
              </td>
              <td><input type="checkbox" [ngModel]="rows.value(t, 'restrictClaims')" (ngModelChange)="rows.set(t, 'restrictClaims', $event)" aria-label="Restrict claims" /></td>
              <td>
                @if (lc) { <span class="staged-note">{{ lc === 'retire' ? 'Retires on save' : 'Revives on save' }}</span> }
                @else { <span [class]="lcStamp(t.lifecycleState)">{{ t.lifecycleState }}</span> }
              </td>
              <td>
                <a class="quiet" [routerLink]="['/teams', t.id]">Open page</a>
                @if (lc) {
                  <button class="quiet" (click)="rows.toggleLifecycle(t, lc)">Undo</button>
                } @else if (t.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="rows.toggleLifecycle(t, 'retire')">Retire</button>
                } @else if (t.lifecycleState === 'retired') {
                  <button class="quiet" (click)="rows.toggleLifecycle(t, 'revive')">Revive</button>
                }
              </td>
            </tr>
          } @empty { <tr><td colspan="6" class="muted">No teams.</td></tr> }
        </tbody>
      </table>
    </div>
    <save-bar [count]="rows.count()" [where]="where()" [saving]="busy()" [error]="saveError()" [stale]="stale()"
              (save)="save()" (discard)="discard()" (reload)="reload()" />
  `,
})
export class TeamsAdminComponent implements OnDestroy {
  private readonly orgApi = inject(OrgApi);
  private readonly unsaved = inject(UnsavedChangesService);
  readonly rows = new StagedRows<Team, Fields>(
    (t) => ({ name: t.name, restrictClaims: t.restrictClaims, divisionId: t.divisionId }),
    () => ({ name: '', restrictClaims: false, divisionId: '' }),
  );
  readonly divisions = signal<Division[]>([]);
  readonly busy = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);

  readonly where = computed(() => {
    const names = this.rows.saved().filter((t) => this.rows.isChanged(t)).map((t) => t.name);
    const added = this.rows.creates().length;
    return [...names, ...(added ? [`${added} new`] : [])].join(', ') || null;
  });

  lcStamp(state: string): string { return `stamp stamp--lc-${state}`; }
  computeColor(t: Team): string { return computeTeamColor(t.name); }
  divisionName(id: string): string {
    return this.divisions().find((d) => d.id === id)?.name ?? '';
  }

  constructor() {
    effect(() => this.unsaved.pending.set(this.rows.count()));
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  private async load(discard: boolean): Promise<void> {
    try {
      const [teams, divisions] = await Promise.all([
        firstValueFrom(this.orgApi.listTeams(true)),
        firstValueFrom(this.orgApi.listDivisions()),
      ]);
      if (discard) this.rows.reset(teams);
      else this.rows.saved.set(teams);
      this.divisions.set(divisions);
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    }
  }

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
    if (this.rows.creates().some((c) => !c.fields.name.trim() || !c.fields.divisionId)) {
      this.saveError.set('Give every new team a name and a division, or remove it.');
      return;
    }
    const ops: StagedOp[] = [
      ...this.rows.creates().map((c) => ({
        run: () =>
          firstValueFrom(
            this.orgApi.createTeam({ name: c.fields.name.trim(), divisionId: c.fields.divisionId, restrictClaims: c.fields.restrictClaims }),
          ),
        clear: () => this.rows.removeCreate(c.key),
      })),
      ...Object.entries(this.rows.edits()).map(([id, { divisionId: _fixed, ...patch }]) => ({
        run: () => {
          const t = this.rows.saved().find((x) => x.id === id)!;
          return firstValueFrom(this.orgApi.updateTeam(id, { ...patch, version: t.version }));
        },
        clear: () => this.rows.clearEdit(id),
      })),
      ...Object.entries(this.rows.lifecycle()).map(([id, op]) => ({
        run: () => firstValueFrom(op === 'retire' ? this.orgApi.retireTeam(id) : this.orgApi.reviveTeam(id)),
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
