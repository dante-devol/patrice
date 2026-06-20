import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { LookupStore } from '../../core/lookup.store';
import { Task, TaskFilters, TaskStatus } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

const STATUSES: TaskStatus[] = ['open', 'claimed', 'review', 'revising', 'approved'];

/**
 * Task list (Slice 4): a faceted filter bar over division/team/status with keyset
 * "load more" paging, plus an inline create form. Filters and create options reflect
 * the (best-effort) division/team lists; the API re-authorizes every create.
 */
@Component({
  selector: 'task-list',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="panel">
      <h2>Tasks</h2>

      <div class="row filters">
        <select [(ngModel)]="filters.division" (ngModelChange)="reload()">
          <option [ngValue]="undefined">All divisions</option>
          @for (d of lookup.divisionList(); track d.id) { <option [ngValue]="d.id">{{ d.name }}</option> }
        </select>
        <select [(ngModel)]="filters.team" (ngModelChange)="reload()">
          <option [ngValue]="undefined">All teams</option>
          @for (t of lookup.teamList(); track t.id) { <option [ngValue]="t.id">{{ t.name }}</option> }
        </select>
        <select [(ngModel)]="filters.status" (ngModelChange)="reload()">
          <option [ngValue]="undefined">Any status</option>
          @for (s of statuses; track s) { <option [ngValue]="s">{{ s }}</option> }
        </select>
        <button class="secondary" (click)="reload()" [disabled]="busy()">Refresh</button>
      </div>

      @if (error()) { <p class="error">{{ error() }}</p> }

      <table>
        <thead>
          <tr><th>Name</th><th>Division</th><th>Team</th><th>Status</th><th>Openings</th><th>Requester</th></tr>
        </thead>
        <tbody>
          @for (t of tasks(); track t.id) {
            <tr>
              <td><a [routerLink]="['/tasks', t.id]">{{ t.name }}</a></td>
              <td>{{ lookup.divisionName(t.divisionId) }}</td>
              <td>{{ lookup.teamName(t.teamId) }}</td>
              <td><span class="badge">{{ t.statusCache ?? '—' }}</span>@if (t.claimsClosed) { <span class="badge">closed</span> }</td>
              <td>{{ t.openings }}</td>
              <td>{{ lookup.userName(t.requesterUserId) }}</td>
            </tr>
          } @empty { <tr><td colspan="6" class="muted">No tasks.</td></tr> }
        </tbody>
      </table>
      @if (nextCursor()) {
        <button class="secondary" (click)="loadMore()" [disabled]="busy()">Load more</button>
      }
    </div>

    <div class="panel">
      <h3>Create task</h3>
      <label>Name</label>
      <input [(ngModel)]="newTask.name" placeholder="Task name" />
      <label>Description (markdown)</label>
      <textarea rows="3" [(ngModel)]="newTask.description" placeholder="Optional"></textarea>
      <label>Division</label>
      <select [(ngModel)]="newTask.divisionId">
        <option [ngValue]="''">Select a division…</option>
        @for (d of lookup.divisionList(); track d.id) { <option [ngValue]="d.id">{{ d.name }}</option> }
      </select>
      <label>Team (optional)</label>
      <select [(ngModel)]="newTask.teamId">
        <option [ngValue]="''">No team</option>
        @for (t of lookup.teamList(); track t.id) { <option [ngValue]="t.id">{{ t.name }}</option> }
      </select>
      @if (createError()) { <p class="error">{{ createError() }}</p> }
      <button (click)="create()" [disabled]="busy() || !newTask.name.trim() || !newTask.divisionId">
        Create task
      </button>
      @if (lookup.divisionList().length === 0) {
        <p class="muted">Tip: division options are visible to org admins. You can still open a task by URL.</p>
      }
    </div>
  `,
  styles: [
    `.filters select { width: auto; min-width: 9rem; }
     textarea { width: 100%; padding: 9px 10px; background: #0d0f14; border: 1px solid var(--border); border-radius: 7px; color: var(--text); }
     .badge { margin-right: 4px; }`,
  ],
})
export class TaskListComponent {
  private readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);

  readonly statuses = STATUSES;
  readonly tasks = signal<Task[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly createError = signal<string | null>(null);

  filters: TaskFilters = {};
  newTask = { name: '', description: '', divisionId: '', teamId: '' };

  constructor() {
    // Refresh (not ensureLoaded) so a division/team added elsewhere in the session
    // — e.g. just now in the Admin pane — shows up in the create-form options
    // without a hard reload.
    void this.lookup.refresh().then(() => this.reload());
  }

  async reload(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.api.listTasks(this.cleanFilters(), { limit: 20 });
      this.tasks.set(res.items);
      this.nextCursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const after = this.nextCursor();
    if (!after) return;
    this.busy.set(true);
    try {
      const res = await this.api.listTasks(this.cleanFilters(), { after, limit: 20 });
      this.tasks.update((cur) => [...cur, ...res.items]);
      this.nextCursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.createError.set(null);
    try {
      await this.api.createTask({
        name: this.newTask.name.trim(),
        description: this.newTask.description || undefined,
        divisionId: this.newTask.divisionId,
        teamId: this.newTask.teamId || undefined,
      });
      this.newTask = { name: '', description: '', divisionId: '', teamId: '' };
      await this.reload();
    } catch (e) {
      this.createError.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Drop empty facets so the query string only carries set filters. */
  private cleanFilters(): TaskFilters {
    const f: TaskFilters = {};
    if (this.filters.division) f.division = this.filters.division;
    if (this.filters.team) f.team = this.filters.team;
    if (this.filters.status) f.status = this.filters.status;
    return f;
  }
}
