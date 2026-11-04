import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../core/auth.store';
import { ApiService } from '../core/api.service';
import { LookupStore } from '../core/lookup.store';
import { Task, TaskStatus } from '../core/api.types';
import { errorMessage } from '../core/errors';
import { UserAvatarComponent } from './tasks/user-avatar.component';
import { TaskRowComponent } from './tasks/task-row.component';
import { stampLabel } from './tasks/task-presentation';

const ACTIVE_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising'];
const LEDGER_STATUSES: TaskStatus[] = ['claimed', 'review', 'revising', 'approved'];


/**
 * Home dashboard. Shows the signed-in user's identity sheet with per-status counts, then
 * their claimed tasks as rows on a ruled sheet (`task-row`), with a status switcher and a
 * "Show done" toggle for approved tasks.
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
        @if (activeTasks().length) {
          <div class="sheet">
            @for (t of activeTasks(); track t.id) { <task-row [task]="t" /> }
          </div>
        }

        @if (showDone() && doneTasks().length) {
          <h2 class="font-display font-bold text-[18px] mt-7 mb-2">Done</h2>
          <div class="sheet">
            @for (t of doneTasks(); track t.id) { <task-row [task]="t" /> }
          </div>
        }
      }

      @if (auth.canManageOrg()) {
        <div class="mt-8">
          <a routerLink="/admin" class="text-[13px] text-ink-soft hover:text-ink hover:underline">Manage invitations</a>
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
  label(s: TaskStatus): string {
    return stampLabel(s);
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
}
