import { TasksApi } from '../core/api/work.api';
import { OrgApi } from '../core/api/org.api';
import { firstValueFrom } from 'rxjs';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../core/auth.store';
import { LookupStore } from '../core/lookup.store';
import { MyUnit, Task, TaskStatus } from '../core/api.types';
import { errorMessage } from '../core/errors';
import { UserAvatarComponent } from './tasks/user-avatar.component';
import { TaskRowComponent } from './tasks/task-row.component';
import { stampLabel } from './tasks/task-presentation';

const ACTIVE_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising'];
const LEDGER_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising', 'approved'];


interface UnitCard {
  unit: MyUnit;
  open: number | null;
}

interface WorkGroup {
  key: string;
  label: string;
  unit: MyUnit | null;
  tasks: Task[];
}

/**
 * Home dashboard. Shows the signed-in user's identity sheet with per-status counts, then
 * their claimed tasks as rows on a ruled sheet (`task-row`), with a status switcher and a
 * "Show done" toggle for approved tasks.
 *
 * "Your divisions and teams" has a card per unit you belong to or lead, and your
 * claimed work is grouped under them: a task goes under its team if you're in that
 * team, else under its division if you're in that, else under "Other".
 */
@Component({
  standalone: true,
  imports: [RouterLink, UserAvatarComponent, TaskRowComponent],
  template: `
    <div class="tasks-board font-sans">

      <!-- Identity + status counts -->
      <div class="paper p-5 mb-6 flex items-center gap-5 flex-wrap">
        <user-avatar [name]="name()" [seed]="userId()" [size]="48" [imageUrl]="auth.user()?.avatarUrl ?? null" />
        <div class="min-w-0 flex-1">
          <div class="font-display font-bold text-[22px] leading-tight">{{ name() }}</div>
          <div class="text-[13px] text-ink-soft mt-0.5">{{ email() }}</div>
          @if (auth.user()?.emailVerified === false) {
            <div class="text-[13px] text-rust mt-1.5">
              Your email isn't verified.
              <a routerLink="/verify-email" class="font-bold underline">Resend the link</a>
            </div>
          }
        </div>
        <dl class="flex gap-6 shrink-0 text-[13px]">
          @for (s of ledger; track s) {
            <div class="text-center">
              <dt class="text-ink-soft">{{ label(s) }}</dt>
              <dd class="font-display font-bold text-[20px] leading-tight mt-0.5">{{ statusCount(s) }}</dd>
            </div>
          }
        </dl>
      </div>

      <!-- Your units -->
      @if (cards().length) {
        <h2 class="font-display font-bold text-[18px] mb-2">Your divisions and teams</h2>
        <div class="grid gap-3 mb-7" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
          @for (c of cards(); track c.unit.unitType + c.unit.unitId) {
            <a [routerLink]="['/' + (c.unit.unitType === 'division' ? 'divisions' : 'teams'), c.unit.unitId]"
               class="paper block px-4 py-3 relative overflow-hidden hover:bg-paper-hover">
              <span class="absolute left-0 top-0 bottom-0 w-[3px]" [style.background]="unitColor(c.unit)"></span>
              <div class="text-[13px] text-ink-soft">
                @if (c.unit.unitType === 'team' && c.unit.divisionId) { Team in {{ lookup.divisionName(c.unit.divisionId) }} } @else { Division }
                @if (c.unit.roles.length) { <span class="ml-2.5 font-bold text-ink">{{ roleNames(c.unit) }}</span> }
              </div>
              <div class="font-display font-bold text-[18px] leading-tight mt-0.5">{{ c.unit.name }}</div>
              <div class="text-[13px] text-ink-soft mt-1">
                @if (c.open !== null) { {{ c.open }} open, }{{ claimedIn(c.unit) }} claimed by you
              </div>
            </a>
          }
        </div>
      }

      <!-- Section header + filters -->
      <div class="flex items-end justify-between gap-4 mb-3 flex-wrap border-b border-line">
        <div class="flex items-baseline gap-3 pb-1.5">
          <h1 class="font-display font-bold text-[22px] leading-tight">Your work</h1>
          <span class="text-[13px] text-ink-soft">
            {{ activeCount() }} active@if (approvedCount()) {, {{ approvedCount() }} done}
          </span>
        </div>

        <div class="flex flex-wrap gap-x-5 text-[13px]">
          <button class="pb-1.5 -mb-px border-b-2"
                  [class]="!statusFilter() ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                  (click)="statusFilter.set(null)">All</button>
          @for (s of activeStatuses; track s) {
            <button class="pb-1.5 -mb-px border-b-2"
                    [class]="statusFilter() === s ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                    (click)="statusFilter.set(s)">{{ label(s) }}</button>
          }
          @if (approvedCount()) {
            <button class="pb-1.5 -mb-px border-b-2"
                    [class]="showDone() ? 'border-ink text-ink font-bold' : 'border-transparent text-ink-soft hover:text-ink'"
                    [attr.aria-pressed]="showDone()"
                    (click)="showDone.set(!showDone())">Show done ({{ approvedCount() }})</button>
          }
        </div>
      </div>

      @if (error()) { <p class="text-[13px] text-rust mb-3">{{ error() }}</p> }

      @if (loading()) {
        <p class="text-[13.5px] text-ink-soft">Loading…</p>
      } @else if (activeTasks().length === 0 && !showDone()) {
        <div class="paper px-5 py-8 text-center">
          <p class="font-display font-bold text-[17px] mb-1">Nothing claimed yet</p>
          <p class="text-[13.5px] text-ink-soft">
            Claim a task on the <a routerLink="/tasks" class="font-bold underline">work board</a>.
          </p>
        </div>
      } @else {
        @for (g of groups(); track g.key) {
          @if (groups().length > 1) {
            <h3 class="text-[13px] font-bold mt-4 mb-1.5">
              @if (g.unit) {
                <a [routerLink]="['/' + (g.unit.unitType === 'division' ? 'divisions' : 'teams'), g.unit.unitId]" class="hover:underline">{{ g.label }}</a>
              } @else { {{ g.label }} }
            </h3>
          }
          <div class="sheet">
            @for (t of g.tasks; track t.id) { <task-row [task]="t" /> }
          </div>
        }

        @if (showDone() && doneTasks().length) {
          <h2 class="font-display font-bold text-[18px] mt-7 mb-2">Done</h2>
          <div class="sheet">
            @for (t of doneTasks(); track t.id) { <task-row [task]="t" /> }
          </div>
        }
      }

      @if (auth.canInvite() && auth.canManageOrg()) {
        <div class="mt-8">
          <a routerLink="/admin" class="text-[13px] text-ink-soft hover:text-ink hover:underline">Manage invitations</a>
        </div>
      }
    </div>
  `,
})
export class HomeComponent implements OnInit {
  readonly auth = inject(AuthStore);
  private readonly tasksApi = inject(TasksApi);
  private readonly orgApi = inject(OrgApi);
  readonly lookup = inject(LookupStore);

  readonly tasks = signal<Task[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly statusFilter = signal<TaskStatus | null>(null);
  readonly showDone = signal(false);
  readonly units = signal<MyUnit[]>([]);
  readonly openByUnit = signal<Map<string, number>>(new Map());

  readonly ledger = LEDGER_STATUSES;
  readonly activeStatuses = ACTIVE_STATUSES;

  readonly name = computed(() => this.auth.user()?.displayName ?? '');
  readonly userId = computed(() => this.auth.user()?.id ?? '');
  readonly email = computed(() => this.auth.user()?.email ?? '');

  readonly activeTasks = computed(() => {
    const f = this.statusFilter();
    const active = this.tasks().filter((t) => t.statusCache !== 'approved');
    return f ? active.filter((t) => t.statusCache === f) : active;
  });
  readonly doneTasks = computed(() => this.tasks().filter((t) => t.statusCache === 'approved'));
  readonly activeCount = computed(() => this.tasks().filter((t) => t.statusCache !== 'approved').length);
  readonly approvedCount = computed(() => this.doneTasks().length);

  readonly cards = computed<UnitCard[]>(() =>
    this.units().map((unit) => ({ unit, open: this.openByUnit().get(unitKey(unit)) ?? null })),
  );

  /** Active work, grouped under your units (team first, then division, then Other). */
  readonly groups = computed<WorkGroup[]>(() => {
    const units = this.units();
    const teams = new Map(units.filter((u) => u.unitType === 'team').map((u) => [u.unitId, u]));
    const divisions = new Map(units.filter((u) => u.unitType === 'division').map((u) => [u.unitId, u]));
    const groups = new Map<string, WorkGroup>();
    for (const t of this.activeTasks()) {
      const unit = (t.teamId ? teams.get(t.teamId) : undefined) ?? divisions.get(t.divisionId) ?? null;
      const key = unit ? unitKey(unit) : 'other';
      let g = groups.get(key);
      if (!g) {
        g = { key, label: unit ? unit.name : 'Other', unit, tasks: [] };
        groups.set(key, g);
      }
      g.tasks.push(t);
    }
    const order = new Map(units.map((u, i) => [unitKey(u), i]));
    return [...groups.values()].sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
  });

  unitColor(u: MyUnit): string {
    return this.lookup.divisionColor(u.unitType === 'division' ? u.unitId : (u.divisionId ?? ''));
  }
  roleNames(u: MyUnit): string {
    return u.roles.map((r) => r.name).join(', ');
  }
  claimedIn(u: MyUnit): number {
    return this.tasks().filter((t) =>
      t.statusCache !== 'approved' && (u.unitType === 'division' ? t.divisionId === u.unitId : t.teamId === u.unitId),
    ).length;
  }

  statusCount(s: TaskStatus): number {
    return this.tasks().filter((t) => t.statusCache === s).length;
  }
  label(s: TaskStatus): string {
    return stampLabel(s);
  }

  ngOnInit(): void {
    void this.load();
  }

  /** Open counts per card, from each unit's stats (over the tasks you can see). */
  private async loadOpenCounts(units: MyUnit[]): Promise<void> {
    const entries = await Promise.all(
      units.map(async (u) => {
        try {
          const s = await firstValueFrom(this.orgApi.unitStats(u.unitType, u.unitId));
          return [unitKey(u), s.byStatus.open] as const;
        } catch {
          return null;
        }
      }),
    );
    this.openByUnit.set(new Map(entries.filter((e): e is readonly [string, number] => e !== null)));
  }

  private async load(): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) return;
    this.loading.set(true);
    try {
      await this.lookup.ensureLoaded();
      const [result, units] = await Promise.all([
        firstValueFrom(this.tasksApi.listTasks({ claimant: userId })),
        firstValueFrom(this.orgApi.myUnits()),
      ]);
      this.tasks.set(result.items);
      this.units.set(units);
      void this.loadOpenCounts(units);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}

function unitKey(u: MyUnit): string {
  return `${u.unitType}:${u.unitId}`;
}
