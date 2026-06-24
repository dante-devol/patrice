import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { LookupStore } from '../../core/lookup.store';
import { Task, TaskFilters, TaskStatus, OrgSettings, IntegrationConnection } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UserAvatarComponent } from './user-avatar.component';
import { isMultiClaim, relativeTime, stampClass, stampStatus } from './task-presentation';

const STATUSES: TaskStatus[] = ['open', 'claimed', 'review', 'revising', 'approved'];

/**
 * Tasks "work board" (Slice 4, ui-tailwind). The faceted list — division chips, a status
 * segmented control, team filter — over keyset "load more" paging, restyled to the
 * drafting-board design: each row is a ticket with a division spine, a rubber-stamp
 * status, and a claim affordance that is the assignee avatar for 1-of-1 tasks (the norm)
 * and only becomes the pip slot-gauge for multi-claim tasks. "Request a task" reveals the
 * inline create form (a task is created by its requester). The API re-authorizes every
 * create.
 */
@Component({
  selector: 'task-list',
  standalone: true,
  imports: [FormsModule, RouterLink, UserAvatarComponent],
  template: `
    @if (discordGated()) {
      <div class="discord-gate">
        <span style="font-size:18px">⚠️</span>
        <span>
          Your organisation requires a linked Discord account to access tasks.
          <a (click)="linkDiscord()" style="cursor:pointer">Link now →</a>
        </span>
      </div>
    }
    <div class="tasks-board font-sans" [style.opacity]="discordGated() ? '0.4' : '1'"
         [style.pointer-events]="discordGated() ? 'none' : 'auto'"
         [title]="discordGated() ? 'Link your Discord account to access tasks' : ''">
      <main class="pb-12">
        <div class="flex items-end justify-between gap-4 mb-5">
          <div>
            <div class="font-mono text-[11.5px] tracking-[0.16em] uppercase text-ink-soft mb-1">Work board</div>
            <h1 class="font-serif text-[30px] leading-[1.05] font-semibold">
              {{ openCount() }} open · <span class="text-ink-soft">{{ inFlightCount() }} in flight</span>
            </h1>
          </div>
          <button
            class="shrink-0 inline-flex items-center gap-2 rounded-md bg-accent text-paper font-medium text-[14px] px-4 py-2.5 shadow-card hover:bg-accent-ink"
            (click)="showCreate.set(!showCreate())">
            <span class="font-mono text-[15px] leading-none">+</span> Request a task
          </button>
        </div>

        <!-- Create form (a task is created by its requester). -->
        @if (showCreate()) {
          <div class="rounded-lg border border-line bg-paper shadow-card p-5 mb-5">
            <h2 class="font-serif text-[18px] font-semibold mb-3">Request a task</h2>
            <div class="grid sm:grid-cols-2 gap-3">
              <label class="block sm:col-span-2">
                <span class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Name</span>
                <input [(ngModel)]="newTask.name" placeholder="What needs doing?" class="field mt-1" />
              </label>
              <label class="block sm:col-span-2">
                <span class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Description (markdown)</span>
                <textarea rows="3" [(ngModel)]="newTask.description" placeholder="Optional" class="field mt-1"></textarea>
              </label>
              <label class="block">
                <span class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Division</span>
                <select [(ngModel)]="newTask.divisionId" class="field mt-1">
                  <option [ngValue]="''">Select a division…</option>
                  @for (d of lookup.divisionList(); track d.id) { <option [ngValue]="d.id">{{ d.name }}</option> }
                </select>
              </label>
              <label class="block">
                <span class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Team (optional)</span>
                <select [(ngModel)]="newTask.teamId" class="field mt-1">
                  <option [ngValue]="''">No team</option>
                  @for (t of lookup.teamList(); track t.id) { <option [ngValue]="t.id">{{ t.name }}</option> }
                </select>
              </label>
            </div>
            @if (createError()) { <p class="text-[13px] text-[#99492f] mt-2">{{ createError() }}</p> }
            <div class="flex items-center gap-3 mt-4">
              <button class="rounded-md bg-accent text-paper font-medium text-[13.5px] px-4 py-2 hover:bg-accent-ink disabled:opacity-50"
                      (click)="create()" [disabled]="busy() || !newTask.name.trim() || !newTask.divisionId">Request</button>
              <button class="font-mono text-[12.5px] text-ink-soft hover:text-ink" (click)="showCreate.set(false)">cancel</button>
            </div>
            @if (lookup.divisionList().length === 0) {
              <p class="text-[12.5px] text-ink-soft mt-2">Division options are visible to org admins. You can still open a task by URL.</p>
            }
          </div>
        }

        <!-- Division facets -->
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <button class="chip rounded-full border text-[12.5px] px-3 py-1 font-medium"
                  [class]="!filters.division ? 'border-ink bg-ink text-paper' : 'border-line bg-paper'"
                  (click)="setDivision(undefined)">All divisions</button>
          @for (d of lookup.divisionList(); track d.id) {
            <button class="chip rounded-full border border-line bg-paper text-[12.5px] px-3 py-1 dtag"
                    [class.ring-2]="filters.division === d.id" [class.ring-line]="filters.division === d.id"
                    [style.--c]="divColor(d.id)" (click)="setDivision(d.id)">{{ d.name }}</button>
          }
        </div>

        <!-- Status segmented control + team filter -->
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div class="inline-flex rounded-md border border-line bg-paper overflow-hidden font-mono text-[11.5px] uppercase tracking-[0.08em]">
            <button class="px-3 py-1.5" [class]="!filters.status ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'"
                    (click)="setStatus(undefined)">Any</button>
            @for (s of statuses; track s) {
              <button class="px-3 py-1.5 border-l border-line capitalize"
                      [class]="filters.status === s ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'"
                      (click)="setStatus(s)">{{ s }}</button>
            }
          </div>
          <div class="font-mono text-[12px] text-ink-soft flex items-center gap-2">
            <span>team:</span>
            <select [(ngModel)]="filters.team" (ngModelChange)="reload()" class="text-ink bg-transparent font-mono text-[12px]">
              <option [ngValue]="undefined">all</option>
              @for (t of lookup.teamList(); track t.id) { <option [ngValue]="t.id">{{ t.name }}</option> }
            </select>
          </div>
        </div>

        @if (error()) { <p class="text-[13px] text-[#99492f] mb-3">{{ error() }}</p> }

        <ul class="flex flex-col gap-2.5">
          @for (t of tasks(); track t.id) {
            <li>
              <a [routerLink]="['/tasks', t.id]"
                 class="ticket flex gap-3.5 rounded-lg border border-line bg-paper shadow-card pl-2 pr-4 py-3.5"
                 [class.opacity-90]="t.statusCache === 'approved'"
                 [style.--c]="divColor(t.divisionId)"
                 [style.--tc]="teamCol(t.teamId)">
                <div class="spine"></div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2.5 flex-wrap">
                    <h2 class="font-serif text-[17px] font-semibold leading-tight truncate">{{ t.name }}</h2>
                    <span class="font-mono text-[12px] text-ink-soft">#{{ shortId(t.id) }}</span>
                  </div>
                  @if (t.description) {
                    <p class="text-[13.5px] text-ink-soft mt-1 line-clamp-1">{{ t.description }}</p>
                  }
                  <div class="flex items-center gap-3 mt-2 flex-wrap">
                    <span class="dtag">{{ lookup.divisionName(t.divisionId) }}</span>
                    @if (t.teamId) { <span class="ttag">{{ lookup.teamName(t.teamId) }}</span> }
                    <span class="font-mono text-[12px] text-ink-soft">requested by {{ lookup.userName(t.requesterUserId) }} · {{ rel(t.createdAt) }}</span>
                  </div>
                </div>
                <div class="flex flex-col items-end justify-between shrink-0 gap-3">
                  <span class="stamp" [class]="stampMod(t)">{{ stamp(t) }}</span>
                  @if (multi(t)) {
                    <div class="flex items-center gap-0.5 flex-wrap justify-end">
                      @for (uid of t.claimantUserIds; track uid) {
                        <user-avatar [name]="lookup.userName(uid)" [seed]="uid" [size]="20" />
                      }
                      @for (p of emptySlots(t); track $index) {
                        <user-avatar [empty]="true" [size]="20" />
                      }
                      <span class="gauge-n ml-1">{{ t.claimantUserIds.length }}/{{ t.openings }}</span>
                    </div>
                  } @else if (t.claimantUserIds.length > 0) {
                    <user-avatar [name]="lookup.userName(t.claimantUserIds[0])" [seed]="t.claimantUserIds[0]" [size]="26" />
                  } @else {
                    <user-avatar [empty]="true" [size]="26" />
                  }
                </div>
              </a>
            </li>
          } @empty {
            <li class="rounded-lg border border-dashed border-line bg-paper/60 px-5 py-10 text-center">
              <p class="font-serif text-[17px] mb-1">Nothing on the board</p>
              <p class="text-[13.5px] text-ink-soft">No tasks match these facets. Try clearing a filter, or request a task.</p>
            </li>
          }
        </ul>

        @if (nextCursor()) {
          <div class="mt-6 flex justify-center">
            <button class="font-mono text-[12.5px] text-ink-soft border border-line bg-paper rounded-md px-4 py-2 hover:text-ink hover:border-ink/40 disabled:opacity-50"
                    (click)="loadMore()" [disabled]="busy()">load 20 more →</button>
          </div>
        }
      </main>
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 9px 11px; background: #fff; border: 1px solid #d3d5cc; border-radius: 7px; color: #191b19; font: inherit; }
     .field:focus-visible { outline: 2px solid #0f7a6b; outline-offset: 1px; }
     .discord-gate { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 16px; background: rgba(255,107,107,.08); border: 1px solid var(--danger,#c0392b); border-radius: 8px; font-size: 13px; }
     .discord-gate a { color: var(--accent,#0f7a6b); cursor: pointer; }`,
  ],
})
export class TaskListComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);
  readonly lookup = inject(LookupStore);
  readonly settings = signal<OrgSettings | null>(null);
  readonly discordConnectionId = signal<string | null>(null);

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

  readonly discordGated = computed(
    () =>
      this.settings()?.requireDiscordLink === true &&
      this.auth.user()?.hasDiscordLink === false,
  );

  constructor() {
    // Refresh (not ensureLoaded) so a division/team added elsewhere this session shows up
    // in the facets + create-form options without a hard reload.
    void this.lookup.refresh().then(() => this.reload());
    void this.loadGateState();
  }

  private async loadGateState(): Promise<void> {
    const [cfg, connections] = await Promise.all([
      this.api.getConfig().catch(() => null),
      this.api.listIntegrations().catch(() => []),
    ]);
    this.settings.set(cfg);
    const active = connections.find((c: IntegrationConnection) => c.provider === 'discord' && c.lifecycleState === 'active');
    this.discordConnectionId.set(active?.id ?? null);
  }

  linkDiscord(): void {
    // Full-page OAuth navigation; the callback links the account and returns to /account.
    window.location.href = '/api/auth/discord/link';
  }

  // ---- view helpers ----
  divColor(id: string): string { return this.lookup.divisionColor(id); }
  teamCol(id: string | null): string { return this.lookup.teamColor(id); }
  rel(iso: string): string {
    return relativeTime(iso);
  }
  shortId(id: string): string {
    return id.replace(/-/g, '').slice(0, 4);
  }
  stamp(t: Task): TaskStatus {
    return stampStatus(t.statusCache);
  }
  stampMod(t: Task): string {
    return stampClass(t.statusCache);
  }
  isOpen(t: Task): boolean {
    return this.stamp(t) === 'open';
  }
  multi(t: Task): boolean {
    return isMultiClaim(t);
  }
  emptySlots(t: Task): unknown[] {
    return new Array(Math.max(0, t.openings - t.claimantUserIds.length));
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
