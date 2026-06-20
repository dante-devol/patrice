import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { Division } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { QuestionnaireBuilderComponent } from '../../features/questionnaire/questionnaire-builder.component';

/** Divisions editor (Slice 2.2): name, default openings, openings-locked, restrict-claims. */
@Component({
  selector: 'divisions-admin',
  standalone: true,
  imports: [FormsModule, QuestionnaireBuilderComponent],
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
          <tr><th>Name</th><th>Default openings</th><th>Locked</th><th>Restrict claims</th><th>State</th><th></th></tr>
        </thead>
        <tbody>
          @for (d of divisions(); track d.id) {
            <tr>
              <td><input [(ngModel)]="d.name" (blur)="save(d, { name: d.name })" /></td>
              <td>
                <input type="number" min="0" [(ngModel)]="d.defaultOpenings"
                       (blur)="save(d, { defaultOpenings: +d.defaultOpenings })" style="width:5rem" />
              </td>
              <td><input type="checkbox" [(ngModel)]="d.openingsLocked"
                         (change)="save(d, { openingsLocked: d.openingsLocked })" /></td>
              <td><input type="checkbox" [(ngModel)]="d.restrictClaims"
                         (change)="save(d, { restrictClaims: d.restrictClaims })" /></td>
              <td>{{ d.lifecycleState }}</td>
              <td>
                <button class="secondary" (click)="toggleQuestionnaire(d.id)">
                  {{ openQuestionnaire() === d.id ? 'Hide questionnaire' : 'Questionnaire' }}
                </button>
                @if (d.lifecycleState === 'active') {
                  <button class="secondary" (click)="retire(d)">Retire</button>
                } @else if (d.lifecycleState === 'retired') {
                  <button class="secondary" (click)="revive(d)">Revive</button>
                }
              </td>
            </tr>
            @if (openQuestionnaire() === d.id) {
              <tr><td colspan="6"><questionnaire-builder [divisionId]="d.id" /></td></tr>
            }
          } @empty { <tr><td colspan="6" class="muted">No divisions.</td></tr> }
        </tbody>
      </table>
    </div>
  `,
})
export class DivisionsAdminComponent {
  readonly api = inject(ApiService);
  readonly divisions = signal<Division[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** Id of the division whose questionnaire builder is expanded (one at a time). */
  readonly openQuestionnaire = signal<string | null>(null);
  newName = '';

  toggleQuestionnaire(id: string): void {
    this.openQuestionnaire.update((cur) => (cur === id ? null : id));
  }

  constructor() {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.divisions.set(await this.api.listDivisions());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createDivision({ name: this.newName.trim() });
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
      await this.api.updateDivision(d.id, patch);
    } catch (e) {
      this.error.set(errorMessage(e));
      await this.refresh();
    }
  }

  async retire(d: Division): Promise<void> {
    await this.guard(() => this.api.retireDivision(d.id));
  }
  async revive(d: Division): Promise<void> {
    await this.guard(() => this.api.reviveDivision(d.id));
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
