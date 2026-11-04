import { OrgApi } from '../../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Division } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { RequestTemplateBuilderComponent } from '../../features/request-template/request-template-builder.component';
import { divisionColor as computeDivColor } from '../tasks/task-presentation';

/** Divisions editor (Slice 2.2): name, default openings, openings-locked, restrict-claims. */
@Component({
  selector: 'divisions-admin',
  standalone: true,
  imports: [FormsModule, RequestTemplateBuilderComponent],
  template: `
    <div class="panel">
      <h2>Divisions</h2>
      <div class="row">
        <input [(ngModel)]="newName" placeholder="New division name" />
        <button [disabled]="busy() || !newName.trim()" (click)="create()">Create division</button>
      </div>
      @if (error()) { <p class="error">{{ error() }}</p> }
      <table>
        <thead>
          <tr><th>Name</th><th>Color</th><th>Default openings</th><th>Locked</th><th>Restrict claims</th><th>State</th><th></th></tr>
        </thead>
        <tbody>
          @for (d of divisions(); track d.id) {
            <tr [class.row--retired]="d.lifecycleState === 'retired'" [class.row--deactivated]="d.lifecycleState === 'deactivated'">
              <td class="name-cell" [style.--c]="computeColor(d)"><input [(ngModel)]="d.name" (blur)="save(d, { name: d.name })" aria-label="Name" /></td>
              <td>
                <span [style.background]="computeColor(d)" title="Computed from the name"
                      style="display:inline-block;width:26px;height:20px;border-radius:3px"></span>
              </td>
              <td>
                <input type="number" min="0" [(ngModel)]="d.defaultOpenings"
                       (blur)="save(d, { defaultOpenings: +d.defaultOpenings })" style="width:5rem" />
              </td>
              <td><input type="checkbox" [(ngModel)]="d.openingsLocked"
                         (change)="save(d, { openingsLocked: d.openingsLocked })" /></td>
              <td><input type="checkbox" [(ngModel)]="d.restrictClaims"
                         (change)="save(d, { restrictClaims: d.restrictClaims })" /></td>
              <td><span [class]="lcStamp(d.lifecycleState)">{{ d.lifecycleState }}</span></td>
              <td>
                <button class="secondary" (click)="toggleRequestTemplate(d.id)">
                  {{ openRequestTemplate() === d.id ? 'Hide request template' : 'Request template' }}
                </button>
                @if (d.lifecycleState === 'active') {
                  <button class="quiet danger" (click)="retire(d)">Retire</button>
                } @else if (d.lifecycleState === 'retired') {
                  <button class="quiet" (click)="revive(d)">Revive</button>
                }
              </td>
            </tr>
            @if (openRequestTemplate() === d.id) {
              <tr><td colspan="7"><request-template-builder [divisionId]="d.id" /></td></tr>
            }
          } @empty { <tr><td colspan="7" class="muted">No divisions.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class DivisionsAdminComponent {
  readonly orgApi = inject(OrgApi);
  readonly divisions = signal<Division[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Id of the division whose request template builder is expanded (one at a time). */
  readonly openRequestTemplate = signal<string | null>(null);
  newName = '';

  lcStamp(state: string): string { return `stamp stamp--lc-${state}`; }
  computeColor(d: Division): string { return computeDivColor(d.name); }


  toggleRequestTemplate(id: string): void {
    this.openRequestTemplate.update((cur) => (cur === id ? null : id));
  }

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      // Admin view opts into retired rows so retired divisions (and their Revive
      // action) remain visible (Slice 7.2 admin/history opt-out).
      this.divisions.set(await firstValueFrom(this.orgApi.listDivisions(true)));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.orgApi.createDivision({ name: this.newName.trim() }));
      this.newName = '';
      await this.refresh();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async save(d: Division, patch: Partial<Division>): Promise<void> {
    this.error.set(null);
    try {
      await firstValueFrom(this.orgApi.updateDivision(d.id, patch));
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }

  async retire(d: Division): Promise<void> {
    await this.guard(() => firstValueFrom(this.orgApi.retireDivision(d.id)));
  }
  async revive(d: Division): Promise<void> {
    await this.guard(() => firstValueFrom(this.orgApi.reviveDivision(d.id)));
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
