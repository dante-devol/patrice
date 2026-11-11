import { LoadingTableRowsComponent } from '../../shared/loading';
import { OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Division, Role } from '../../core/api.types';
import { DefaultRoleCellComponent } from './default-role-cell.component';
import { errorMessage } from '../../core/errors';
import { UnsavedChangesService } from '../../core/unsaved-changes.service';
import { RequestTemplateBuilderComponent } from '../../features/request-template/request-template-builder.component';
import { divisionColor as computeDivColor } from '../tasks/task-presentation';
import { SaveBarComponent } from './save-bar.component';
import { StagedRows } from './staged-rows';
import { StagedOp, isStale, runStaged, stagedErrorMessage } from './staged';

interface Fields {
  name: string;
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  /** A unit role id, or '' for none (ADR 0022). */
  defaultRoleId: string;
}

/**
 * Divisions editor: name, default openings, openings-locked, restrict-claims, and
 * retire/revive. Every change, new divisions included, is staged until Save. The
 * request template builder below a row is its own editor with its own Save.
 */
@Component({
  selector: 'divisions-admin',
  standalone: true,
  imports: [FormsModule, RouterLink, RequestTemplateBuilderComponent, SaveBarComponent, LoadingTableRowsComponent, DefaultRoleCellComponent],
  template: `
    <div class="panel">
      <h2>Divisions</h2>
      <div class="row">
        <button class="secondary" (click)="rows.addCreate()">Add division</button>
      </div>
      @if (loadError()) { <p class="error">{{ loadError() }}</p> }
      <table [attr.aria-busy]="!loaded()">
        <thead>
          <tr><th>Name</th><th>Color</th><th>Default openings</th><th>Locked</th><th>Restrict claims</th><th>Default role</th><th>State</th><th></th></tr>
        </thead>
        @if (!loaded()) {
          <tbody loadingRows [cols]="8" [rows]="5" label="Loading divisions"></tbody>
        } @else {
        <tbody>
          @for (c of rows.creates(); track c.key) {
            <tr class="is-staged">
              <td><input [ngModel]="c.fields.name" (ngModelChange)="rows.updateCreate(c.key, 'name', $event)" placeholder="New division name" aria-label="Name" /></td>
              <td></td>
              <td><input type="number" min="1" [ngModel]="c.fields.defaultOpenings" (ngModelChange)="rows.updateCreate(c.key, 'defaultOpenings', +$event)" style="width:5rem" aria-label="Default openings" /></td>
              <td><input type="checkbox" [ngModel]="c.fields.openingsLocked" (ngModelChange)="rows.updateCreate(c.key, 'openingsLocked', $event)" aria-label="Openings locked" /></td>
              <td><input type="checkbox" [ngModel]="c.fields.restrictClaims" (ngModelChange)="rows.updateCreate(c.key, 'restrictClaims', $event)" aria-label="Restrict claims" /></td>
              <td><span class="muted" title="New divisions start with the default role set in Settings">From Settings</span></td>
              <td><span class="staged-note">New, added on save</span></td>
              <td><button class="quiet" (click)="rows.removeCreate(c.key)">Remove</button></td>
            </tr>
          }
          @for (d of rows.saved(); track d.id) {
            @let lc = rows.lifecycleOf(d);
            <tr [class.row--retired]="d.lifecycleState === 'retired'" [class.is-staged]="rows.isChanged(d)" [class.is-retiring]="lc === 'retire'">
              <td class="name-cell" [style.--c]="computeColor(d)">
                <input [class.is-changed]="rows.isChanged(d, 'name')" [ngModel]="rows.value(d, 'name')" (ngModelChange)="rows.set(d, 'name', $event)" aria-label="Name" />
              </td>
              <td>
                <span [style.background]="computeColor(d)" title="Computed from the name"
                      style="display:inline-block;width:26px;height:20px;border-radius:2px"></span>
              </td>
              <td>
                <input type="number" min="1" [class.is-changed]="rows.isChanged(d, 'defaultOpenings')" [ngModel]="rows.value(d, 'defaultOpenings')"
                       (ngModelChange)="rows.set(d, 'defaultOpenings', +$event)" style="width:5rem" aria-label="Default openings" />
              </td>
              <td><input type="checkbox" [ngModel]="rows.value(d, 'openingsLocked')" (ngModelChange)="rows.set(d, 'openingsLocked', $event)" aria-label="Openings locked" /></td>
              <td><input type="checkbox" [ngModel]="rows.value(d, 'restrictClaims')" (ngModelChange)="rows.set(d, 'restrictClaims', $event)" aria-label="Restrict claims" /></td>
              <td>
                <default-role-cell [roles]="unitRoles()" [value]="rows.value(d, 'defaultRoleId')" [savedValue]="d.defaultRoleId ?? ''"
                                   [changed]="rows.isChanged(d, 'defaultRoleId')" unitType="division" [unitId]="d.id"
                                   (valueChange)="rows.set(d, 'defaultRoleId', $event)" />
              </td>
              <td>
                @if (lc) { <span class="staged-note">{{ lc === 'retire' ? 'Retires on save' : 'Revives on save' }}</span> }
                @else { <span [class]="lcStamp(d.lifecycleState)">{{ d.lifecycleState }}</span> }
              </td>
              <td>
                <a class="quiet" [routerLink]="['/divisions', d.id]">Open page</a>
                <button class="secondary" (click)="toggleRequestTemplate(d.id)">
                  {{ openRequestTemplate() === d.id ? 'Hide request template' : 'Request template' }}
                </button>
                @if (lc) {
                  <button class="quiet" (click)="rows.toggleLifecycle(d, lc)">Undo</button>
                } @else if (d.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="rows.toggleLifecycle(d, 'retire')">Retire</button>
                } @else if (d.lifecycleState === 'retired') {
                  <button class="quiet" (click)="rows.toggleLifecycle(d, 'revive')">Revive</button>
                }
              </td>
            </tr>
            @if (openRequestTemplate() === d.id) {
              <tr><td colspan="8"><request-template-builder [divisionId]="d.id" /></td></tr>
            }
          } @empty { <tr><td colspan="8" class="muted">No divisions.</td></tr> }
        </tbody>
        }
      </table>
    </div>
    <save-bar [count]="rows.count()" [where]="where()" [saving]="busy()" [error]="saveError()" [stale]="stale()"
              (save)="save()" (discard)="discard()" (reload)="reload()" />
  `,
})
export class DivisionsAdminComponent implements OnDestroy {
  private readonly orgApi = inject(OrgApi);
  private readonly unsaved = inject(UnsavedChangesService);
  readonly rows = new StagedRows<Division, Fields>(
    (d) => ({
      name: d.name,
      defaultOpenings: d.defaultOpenings,
      openingsLocked: d.openingsLocked,
      restrictClaims: d.restrictClaims,
      defaultRoleId: d.defaultRoleId ?? '',
    }),
    () => ({ name: '', defaultOpenings: 1, openingsLocked: false, restrictClaims: false, defaultRoleId: '' }),
  );
  /** Active unit roles, for the default-role picker. */
  readonly unitRoles = signal<Role[]>([]);
  readonly busy = signal(false);
  /** The first load has finished (or failed): until then the table shows placeholders. */
  readonly loaded = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly stale = signal(false);
  /** Id of the division whose request template builder is expanded (one at a time). */
  readonly openRequestTemplate = signal<string | null>(null);

  readonly where = computed(() => {
    const names = this.rows.saved().filter((d) => this.rows.isChanged(d)).map((d) => d.name);
    const added = this.rows.creates().length;
    return [...names, ...(added ? [`${added} new`] : [])].join(', ') || null;
  });

  lcStamp(state: string): string { return `stamp stamp--lc-${state}`; }
  computeColor(d: Division): string { return computeDivColor(d.name); }

  toggleRequestTemplate(id: string): void {
    this.openRequestTemplate.update((cur) => (cur === id ? null : id));
  }

  constructor() {
    effect(() => this.unsaved.pending.set(this.rows.count()));
    void this.load(true);
  }

  ngOnDestroy(): void {
    this.unsaved.pending.set(0);
  }

  /** Read the divisions; `discard` also drops anything staged. */
  private async load(discard: boolean): Promise<void> {
    try {
      // Admin view opts into retired rows so retired divisions (and their Revive
      // action) remain visible.
      const [divisions, roles] = await Promise.all([
        firstValueFrom(this.orgApi.listDivisions(true)),
        firstValueFrom(this.orgApi.listRoles()),
      ]);
      this.unitRoles.set(roles.filter((r) => r.kind === 'unit').sort((a, b) => a.name.localeCompare(b.name)));
      if (discard) this.rows.reset(divisions);
      else this.rows.saved.set(divisions);
      this.loadError.set(null);
    } catch (e) {
      this.loadError.set(errorMessage(e));
    } finally {
      this.loaded.set(true);
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
    const blank = this.rows.creates().find((c) => !c.fields.name.trim());
    if (blank) {
      this.saveError.set('Give every new division a name, or remove it.');
      return;
    }
    const ops: StagedOp[] = [
      ...this.rows.creates().map((c) => ({
        // New divisions take the org's default role (Settings), so it isn't sent.
        run: () => {
          const { defaultRoleId: _unused, ...fields } = c.fields;
          return firstValueFrom(this.orgApi.createDivision({ ...fields, name: fields.name.trim() }));
        },
        clear: () => this.rows.removeCreate(c.key),
      })),
      ...Object.entries(this.rows.edits()).map(([id, patch]) => ({
        run: () => {
          const d = this.rows.saved().find((x) => x.id === id)!;
          const { defaultRoleId, ...rest } = patch;
          return firstValueFrom(
            this.orgApi.updateDivision(id, {
              ...rest,
              ...(defaultRoleId !== undefined ? { defaultRoleId: defaultRoleId || null } : {}),
              version: d.version,
            }),
          );
        },
        clear: () => this.rows.clearEdit(id),
      })),
      ...Object.entries(this.rows.lifecycle()).map(([id, op]) => ({
        run: () => firstValueFrom(op === 'retire' ? this.orgApi.retireDivision(id) : this.orgApi.reviveDivision(id)),
        clear: () => this.rows.clearLifecycle(id),
      })),
    ];
    this.busy.set(true);
    this.saveError.set(null);
    this.stale.set(false);
    const result = await runStaged(ops);
    // Re-read without dropping what's still staged, so a halfway stop keeps the rest.
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
