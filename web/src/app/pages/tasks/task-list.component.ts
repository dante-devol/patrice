import { RequestTemplateBuilderComponent } from '../../features/request-template/request-template-builder.component';
import { TasksApi, TemplatesApi } from '../../core/api/work.api';
import { firstValueFrom } from 'rxjs';
import { Component, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthStore } from '../../core/auth.store';
import { LookupStore } from '../../core/lookup.store';
import { RequestTemplateLibrary, Task, TaskFilters, TaskStatus, TemplateChoice } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { TaskRowComponent } from './task-row.component';
import { stampLabel, stampStatus } from './task-presentation';

const STATUSES: TaskStatus[] = ['open', 'claimed', 'review', 'revising', 'approved'];

/**
 * Tasks "work board". The faceted list — division and status switchers, a team
 * filter — over keyset "load more" paging. Tasks sit as rows on one ruled sheet
 * (`task-row`, see web/DESIGN.md). "Request a task" reveals the inline create form (a task
 * is created by its requester). The API re-authorizes every create.
 */
@Component({
  selector: 'task-list',
  standalone: true,
  imports: [FormsModule, TaskRowComponent, RequestTemplateBuilderComponent],
  template: `
    @if (discordGated()) {
      <div class="discord-gate">
        Your organisation requires a linked Discord account to access tasks.
        <a (click)="linkDiscord()">Link Discord</a>
      </div>
    }
    <div class="tasks-board font-sans" [style.opacity]="discordGated() ? '0.4' : '1'"
         [style.pointer-events]="discordGated() ? 'none' : 'auto'"
         [title]="discordGated() ? 'Link your Discord account to access tasks' : ''">
      <main class="pb-12">
        <div class="flex items-center justify-between gap-4 mb-5 flex-wrap">
          <div class="flex items-baseline gap-3 flex-wrap">
            <h1 class="font-display font-bold text-[28px] leading-tight">Work board</h1>
            <span class="text-[13px] text-ink-soft">{{ openCount() }} open, {{ inFlightCount() }} in progress</span>
          </div>
          <button class="shrink-0 rounded bg-accent text-paper font-bold text-[13px] px-3.5 py-2 hover:bg-accent-ink"
                  (click)="showCreate.set(!showCreate())">Request a task</button>
        </div>

        <!-- Create form (a task is created by its requester). -->
        @if (showCreate()) {
          <div class="paper p-5 mb-5">
            <h2 class="font-display font-bold text-[18px] mb-3">Request a task</h2>
            <div class="grid sm:grid-cols-2 gap-3">
              <label class="block sm:col-span-2">
                <span class="text-[13px] text-ink-soft">Name</span>
                <input [(ngModel)]="newTask.name" placeholder="Localize chapter 4 barks" class="field mt-1" />
              </label>
              <label class="block sm:col-span-2">
                <span class="text-[13px] text-ink-soft">Description (markdown, optional)</span>
                <textarea rows="3" [(ngModel)]="newTask.description" class="field mt-1"></textarea>
              </label>
              <label class="block">
                <span class="text-[13px] text-ink-soft">Division</span>
                <select [(ngModel)]="newTask.divisionId" (ngModelChange)="divisionChosen($event)" class="field mt-1">
                  <option [ngValue]="''">Select a division</option>
                  @for (d of lookup.divisionList(); track d.id) { <option [ngValue]="d.id">{{ d.name }}</option> }
                </select>
              </label>
              <label class="block">
                <span class="text-[13px] text-ink-soft">Team (optional)</span>
                <select [(ngModel)]="newTask.teamId" class="field mt-1">
                  <option [ngValue]="''">No team</option>
                  <!-- A task's team must belong to its division. -->
                  @for (t of lookup.teamList(); track t.id) {
                    @if (t.divisionId === newTask.divisionId) { <option [ngValue]="t.id">{{ t.name }}</option> }
                  }
                </select>
              </label>
              @if (newTask.divisionId) {
                <label class="block sm:col-span-2">
                  <span class="text-[13px] text-ink-soft">Request template</span>
                  <select [(ngModel)]="templateChoice" class="field mt-1" aria-label="Request template">
                    @for (t of library()?.items ?? []; track t.id) {
                      <option [ngValue]="t.id">{{ t.name }}@if (t.isDefault) { (default)} · {{ t.questionCount }} question@if (t.questionCount !== 1) {s}</option>
                    }
                    @if (canCompose()) { <option [ngValue]="'custom'">Write my own</option> }
                  </select>
                  @if (library() && !library()!.items.length && !canCompose()) {
                    <span class="text-[13px] text-rust">This division has no templates yet; ask an admin to add one.</span>
                  }
                </label>
                @if (templateChoice === 'custom') {
                  <div class="sm:col-span-2">
                    <request-template-builder #customBuilder mode="local" />
                  </div>
                }
              }
            </div>
            @if (createError()) { <p class="text-[13px] text-rust mt-2">{{ createError() }}</p> }
            <div class="flex items-center gap-4 mt-4">
              <button class="rounded bg-accent text-paper font-bold text-[13px] px-3.5 py-2 hover:bg-accent-ink disabled:opacity-50"
                      (click)="create()" [disabled]="busy() || !newTask.name.trim() || !newTask.divisionId || !templateChoice">Request task</button>
              <button class="text-[13px] text-ink-soft hover:text-ink hover:underline" (click)="showCreate.set(false)">Cancel</button>
            </div>
            @if (lookup.divisionList().length === 0) {
              <p class="text-[13px] text-ink-soft mt-2">You can't request work in any division yet.</p>
            }
          </div>
        }

        <!-- Division facets: the selected division is bold and underlined in its own hue. -->
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 mb-3 text-[13px]">
          <button class="pb-0.5 border-b-2"
                  [class]="!filters.division ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                  (click)="setDivision(undefined)">All divisions</button>
          @for (d of lookup.divisionList(); track d.id) {
            <button class="pb-0.5 border-b-2"
                    [class.font-bold]="filters.division === d.id"
                    [style.color]="divColor(d.id)"
                    [style.borderColor]="filters.division === d.id ? divColor(d.id) : 'transparent'"
                    (click)="setDivision(d.id)">{{ d.name }}</button>
          }
        </div>

        <!-- Status switcher + team filter -->
        <div class="flex flex-wrap items-end justify-between gap-3 mb-3 text-[13px] border-b border-line">
          <div class="flex flex-wrap gap-x-5">
            <button class="pb-1.5 -mb-px border-b-2"
                    [class]="!filters.status ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                    (click)="setStatus(undefined)">Any status</button>
            @for (s of statuses; track s) {
              <button class="pb-1.5 -mb-px border-b-2"
                      [class]="filters.status === s ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                      (click)="setStatus(s)">{{ statusLabel(s) }}</button>
            }
          </div>
          <label class="flex items-center gap-2 pb-1.5 text-ink-soft">
            <span>Team</span>
            <select [(ngModel)]="filters.team" (ngModelChange)="reload()" class="text-ink border border-line rounded bg-paper px-2 py-0.5">
              <option [ngValue]="undefined">All teams</option>
              @for (t of lookup.teamList(); track t.id) { <option [ngValue]="t.id">{{ t.name }}</option> }
            </select>
          </label>
        </div>

        @if (error()) { <p class="text-[13px] text-rust mb-3">{{ error() }}</p> }

        <div class="sheet">
          @for (t of tasks(); track t.id) {
            <task-row [task]="t" />
          } @empty {
            <div class="px-5 py-10 text-center">
              <p class="font-display font-bold text-[17px] mb-1">No tasks match these filters</p>
              <p class="text-[13.5px] text-ink-soft">Clear a filter, or request a task.</p>
            </div>
          }
        </div>

        @if (nextCursor()) {
          <div class="mt-5 flex justify-center">
            <button class="text-[13px] font-bold border border-line bg-paper rounded px-3.5 py-2 hover:bg-paper-hover disabled:opacity-50"
                    (click)="loadMore()" [disabled]="busy()">Load 20 more</button>
          </div>
        }
      </main>
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 2px; color: var(--ink); font: inherit; }
     .field:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
     .discord-gate { padding: 10px 14px; margin-bottom: 16px; background: var(--paper); border: 1px solid var(--line); border-left: 3px solid var(--rust); border-radius: 2px; font-size: 13px; }
     .discord-gate a { cursor: pointer; font-weight: 700; margin-left: 4px; }`,
  ],
})
export class TaskListComponent {
  private readonly tasksApi = inject(TasksApi);
  private readonly templatesApi = inject(TemplatesApi);
  private readonly auth = inject(AuthStore);
  readonly lookup = inject(LookupStore);

  readonly statuses = STATUSES;
  readonly tasks = signal<Task[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly createError = signal<string | null>(null);
  readonly showCreate = signal(false);

  // Best-effort counts from the loaded page (the list API has no totals endpoint yet).
  readonly openCount = computed(() => this.tasks().filter((t) => this.isOpen(t)).length);
  readonly inFlightCount = computed(() => this.tasks().length - this.openCount());

  filters: TaskFilters = {};
  newTask = { name: '', description: '', divisionId: '', teamId: '' };
  /** The chosen library template's id, or 'custom' for "Write my own". */
  templateChoice: string | null = null;
  readonly library = signal<RequestTemplateLibrary | null>(null);
  /** Composing your own questions is offered when the division permits it for you. */
  readonly canCompose = computed(() => this.library()?.allowedActions.includes('task:compose_template') === true);
  @ViewChild('customBuilder') customBuilder?: RequestTemplateBuilderComponent;

  /** The API enforces requireDiscordLink; this only explains the empty board. */
  readonly discordGated = this.auth.taskAccessBlockedByDiscord;

  constructor() {
    // Refresh (not ensureLoaded) so a division/team added elsewhere this session shows up
    // in the facets + create-form options without a hard reload.
    void this.lookup.refresh().then(() => this.reload());
  }

  linkDiscord(): void {
    // Full-page OAuth navigation; the callback links the account and returns to /account.
    window.location.href = '/api/auth/discord/link';
  }

  // ---- view helpers ----
  divColor(id: string): string { return this.lookup.divisionColor(id); }
  statusLabel(s: TaskStatus): string { return stampLabel(s); }
  isOpen(t: Task): boolean {
    return stampStatus(t.statusCache) === 'open';
  }

  setDivision(id: string | undefined): void {
    this.filters.division = id;
    void this.reload();
  }
  setStatus(s: TaskStatus | undefined): void {
    this.filters.status = s;
    void this.reload();
  }

  async reload(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.tasksApi.listTasks(this.cleanFilters(), { limit: 20 }));
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
      const res = await firstValueFrom(this.tasksApi.listTasks(this.cleanFilters(), { after, limit: 20 }));
      this.tasks.update((cur) => [...cur, ...res.items]);
      this.nextCursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Load the division's library for the picker, preselecting its default. */
  async divisionChosen(divisionId: string): Promise<void> {
    this.newTask.teamId = '';
    this.library.set(null);
    this.templateChoice = null;
    if (!divisionId) return;
    try {
      const lib = await firstValueFrom(this.templatesApi.listRequestTemplates(divisionId));
      this.library.set(lib);
      this.templateChoice = lib.items.find((t) => t.isDefault)?.id ?? lib.items[0]?.id ?? (this.canCompose() ? 'custom' : null);
    } catch (e) {
      this.createError.set(errorMessage(e));
    }
  }

  private chosenTemplate(): TemplateChoice | null {
    if (this.templateChoice === 'custom') {
      return this.customBuilder?.valid ? { kind: 'custom', questions: this.customBuilder.value() } : null;
    }
    return this.templateChoice ? { kind: 'library', templateId: this.templateChoice } : null;
  }

  async create(): Promise<void> {
    const template = this.chosenTemplate();
    if (!template) {
      this.createError.set('Finish the questions first.');
      return;
    }
    this.busy.set(true);
    this.createError.set(null);
    try {
      await firstValueFrom(this.tasksApi.createTask({
        name: this.newTask.name.trim(),
        description: this.newTask.description || undefined,
        divisionId: this.newTask.divisionId,
        teamId: this.newTask.teamId || undefined,
        template,
      }));
      this.newTask = { name: '', description: '', divisionId: '', teamId: '' };
      this.library.set(null);
      this.templateChoice = null;
      this.showCreate.set(false);
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
