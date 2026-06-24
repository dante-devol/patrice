import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../core/auth.store';
import { ApiService } from '../core/api.service';
import { LookupStore } from '../core/lookup.store';
import { Task, TaskStatus } from '../core/api.types';
import { errorMessage } from '../core/errors';
import { UserAvatarComponent } from './tasks/user-avatar.component';
import { relativeTime, stampClass, stampStatus } from './tasks/task-presentation';

const ACTIVE_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising'];
const LEDGER_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising', 'approved'];

const STATUS_COLORS: Record<string, string> = {
  claimed: '#3f443f',
  review: '#8a6a0c',
  revising: '#99492f',
  approved: '#0a5249',
};

/**
 * Home dashboard (ui-tailwind P0 rebuild). Shows the signed-in user's identity
 * card with a ledger stat strip, then their claimed task list with status filter
 * and a "Show done" toggle for approved tasks.
 */
@Component({
  standalone: true,
  imports: [RouterLink, UserAvatarComponent],
  template: `
    <div class="tasks-board font-sans">

      <!-- Identity + ledger card -->
      <div class="rounded-lg border border-line bg-paper shadow-card p-5 mb-6 flex items-center gap-5 flex-wrap">
        <user-avatar [name]="name()" [seed]="userId()" [size]="52" [imageUrl]="auth.user()?.avatarUrl ?? null" />
        <div class="min-w-0 flex-1">
          <div class="font-serif text-[22px] font-semibold leading-tight">{{ name() }}</div>
          <div class="font-mono text-[12px] text-ink-soft mt-0.5">{{ email() }}</div>
          @if (auth.user()?.emailVerified === false) {
            <div class="text-[12.5px] text-[#99492f] mt-1.5">
              Email not verified —
              <a routerLink="/verify-email" class="text-accent-ink underline">resend</a>
            </div>
          }
        </div>
        <!-- Ledger stat strip -->
        <div class="flex border border-line rounded-lg overflow-hidden shrink-0">
          @for (s of ledger; track s; let last = $last) {
            <div class="text-center px-4 py-2.5" [class.border-r]="!last" [class.border-line]="!last">
              <div class="font-mono text-[17px] font-bold leading-none" [style.color]="statusColor(s)">{{ statusCount(s) }}</div>
              <div class="font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-soft mt-1">{{ s }}</div>
            </div>
          }
        </div>
      </div>

      <!-- Section header + filters -->
      <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
        <div>
          <div class="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-soft mb-1">My work</div>
          <div class="font-serif text-[24px] leading-tight font-semibold">
            {{ activeCount() }} active
            @if (approvedCount()) {
              <span class="text-ink-soft"> · {{ approvedCount() }} done</span>
            }
          </div>
        </div>

        <div class="flex items-center gap-2">
          <!-- Status segmented control -->
          <div class="inline-flex rounded-md border border-line bg-paper overflow-hidden font-mono text-[11px] uppercase tracking-[0.08em]">
            <button class="px-3 py-1.5"
                    [class]="!statusFilter() ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'"
                    (click)="statusFilter.set(null)">All</button>
            @for (s of activeStatuses; track s) {
              <button class="px-3 py-1.5 border-l border-line capitalize"
                      [class]="statusFilter() === s ? 'bg-ink text-paper' : 'text-ink-soft hover:text-ink'"
                      (click)="statusFilter.set(s)">{{ s }}</button>
            }
          </div>

          <!-- Show done toggle -->
          @if (approvedCount()) {
            <button class="font-mono text-[11px] uppercase tracking-[0.08em] border rounded-md px-3 py-[5px] leading-none flex items-center gap-1.5"
                    [class]="showDone() ? 'bg-ink text-paper border-ink' : 'border-line text-ink-soft hover:text-ink'"
                    (click)="showDone.set(!showDone())">
              Done
              <span class="font-mono text-[10px] font-bold border-double border-2 rounded px-1 py-0.5 leading-none"
                    [style.color]="showDone() ? 'currentColor' : statusColor('approved')"
                    [style.borderColor]="showDone() ? 'currentColor' : statusColor('approved')">{{ approvedCount() }}</span>
            </button>
          }
        </div>
      </div>

      @if (error()) { <p class="text-[13px] text-[#99492f] mb-3">{{ error() }}</p> }

      @if (loading()) {
        <p class="text-[13.5px] text-ink-soft">Loading…</p>
      } @else if (activeTasks().length === 0 && !showDone()) {
        <div class="rounded-lg border border-dashed border-line bg-paper/50 p-8 text-center">
          <p class="font-mono text-[11.5px] uppercase tracking-[0.12em] text-ink-soft mb-2">No active tasks</p>
          <p class="text-[13.5px] text-ink-soft">
            Claim a task on the <a routerLink="/tasks" class="text-accent-ink hover:underline">work board</a>.
          </p>
        </div>
      } @else {
        <!-- Active tasks -->
        @if (activeTasks().length) {
          <ul class="flex flex-col gap-2.5">
            @for (t of activeTasks(); track t.id) {
              <li>
                <a [routerLink]="['/tasks', t.id]"
                   class="ticket flex gap-3.5 rounded-lg border border-line bg-paper shadow-card pl-2 pr-4 py-3.5"
                   [style.--c]="divColor(t.divisionId)"
                   [style.--tc]="teamCol(t.teamId)">
                  <div class="spine"></div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2.5 flex-wrap">
                      <span class="font-serif text-[17px] font-semibold leading-tight">{{ t.name }}</span>
                      <span class="font-mono text-[12px] text-ink-soft">#{{ shortId(t.id) }}</span>
                    </div>
                    @if (t.description) {
                      <p class="text-[13.5px] text-ink-soft mt-1 line-clamp-1">{{ t.description }}</p>
                    }
                    <div class="flex items-center gap-3 mt-2 flex-wrap">
                      <span class="dtag" [style.--c]="divColor(t.divisionId)">{{ lookup.divisionName(t.divisionId) }}</span>
                      @if (t.teamId) { <span class="ttag" [style.--tc]="teamCol(t.teamId)">{{ lookup.teamName(t.teamId) }}</span> }
                      <span class="font-mono text-[12px] text-ink-soft">· {{ rel(t.createdAt) }}</span>
                    </div>
                  </div>
                  <div class="shrink-0 mt-0.5">
                    <span class="stamp" [class]="stampMod(t)">{{ stamp(t) }}</span>
                  </div>
                </a>
              </li>
            }
          </ul>
        }

        <!-- Done section -->
        @if (showDone() && doneTasks().length) {
          <div class="mt-6">
            <div class="flex items-center gap-3 mb-4">
              <span class="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-soft whitespace-nowrap">
                Done · {{ doneTasks().length }} approved
              </span>
              <div class="flex-1 border-t border-dashed border-line"></div>
            </div>
            <ul class="flex flex-col gap-2.5" style="opacity:0.7">
              @for (t of doneTasks(); track t.id) {
                <li>
                  <a [routerLink]="['/tasks', t.id]"
                     class="ticket flex gap-3.5 rounded-lg border border-line bg-paper shadow-card pl-2 pr-4 py-3.5"
                     [style.--c]="divColor(t.divisionId)"
                     [style.--tc]="teamCol(t.teamId)">
                    <div class="spine"></div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2.5 flex-wrap">
                        <span class="font-serif text-[17px] font-semibold leading-tight">{{ t.name }}</span>
                        <span class="font-mono text-[12px] text-ink-soft">#{{ shortId(t.id) }}</span>
                      </div>
                      <div class="flex items-center gap-3 mt-2 flex-wrap">
                        <span class="dtag" [style.--c]="divColor(t.divisionId)">{{ lookup.divisionName(t.divisionId) }}</span>
                        @if (t.teamId) { <span class="ttag" [style.--tc]="teamCol(t.teamId)">{{ lookup.teamName(t.teamId) }}</span> }
                        <span class="font-mono text-[12px] text-ink-soft">· {{ rel(t.createdAt) }}</span>
                      </div>
                    </div>
                    <div class="shrink-0 mt-0.5">
                      <span class="stamp stamp--approved">approved</span>
                    </div>
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      }

      @if (auth.canManageOrg()) {
        <div class="mt-8 pt-4 border-t border-line/50">
          <a routerLink="/admin" class="font-mono text-[11.5px] text-ink-soft hover:text-ink">
            Manage invitations →
          </a>
        </div>
      }
    </div>
  `,
})
export class HomeComponent implements OnInit {
  readonly auth = inject(AuthStore);
  private readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);

  readonly tasks = signal<Task[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly statusFilter = signal<TaskStatus | null>(null);
  readonly showDone = signal(false);

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

  statusCount(s: TaskStatus): number {
    return this.tasks().filter((t) => t.statusCache === s).length;
  }
  statusColor(s: string): string {
    return STATUS_COLORS[s] ?? '#5b605c';
  }

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const userId = this.auth.user()?.id;
    if (!userId) return;
    this.loading.set(true);
    try {
      await this.lookup.ensureLoaded();
      const result = await this.api.listTasks({ claimant: userId });
      this.tasks.set(result.items);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  divColor(id: string): string { return this.lookup.divisionColor(id); }
  teamCol(id: string | null): string { return this.lookup.teamColor(id); }
  rel(iso: string): string { return relativeTime(iso); }
  shortId(id: string): string { return id.replace(/-/g, '').slice(0, 4); }
  stamp(t: Task): string { return stampStatus(t.statusCache); }
  stampMod(t: Task): string { return stampClass(t.statusCache); }
}
