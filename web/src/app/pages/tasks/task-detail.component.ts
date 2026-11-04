import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Dialog } from '@angular/cdk/dialog';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ApiService } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { LookupStore } from '../../core/lookup.store';
import { ToastService } from '../../core/toast.service';
import { AdminUser, QuestionType, Submission, Task, TaskTemplate } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { MessageThreadComponent } from './message-thread.component';
import { SubmitDialogComponent } from './submit-dialog.component';
import { UserAvatarComponent } from './user-avatar.component';
import { isMultiClaim, relativeTime, shortTaskId, stampClass, stampLabel } from './task-presentation';

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  detail_text: 'Long text',
  multiline: 'Multi-line text',
  text: 'Short text',
  numeric: 'Number',
  dropdown: 'Dropdown',
  radio: 'Single choice',
  attachment: 'File',
};

/** One claim slot on a task; state/version overlaid from the claimant's latest submission. */
interface ClaimRow {
  userId: string;
  name: string;
  version: number | null;
  state: string | null;
}

/**
 * Task detail (Slice 4–5, ui-tailwind). Unified-History main column with inline-editable
 * title and description, sticky rail with restructured claim strip (Close Claims button,
 * per-slot Claim/Leave icon buttons), facts rail with searchable requester combobox, and
 * a Mark Complete split-button below the Request Template panel. Submit Work is a large
 * button at the bottom of the main column. The ⋯ overflow menu lives in the title row.
 */
@Component({
  selector: 'task-detail',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, MessageThreadComponent, UserAvatarComponent, CdkMenuTrigger, CdkMenu, CdkMenuItem],
  template: `
    <div class="tasks-board font-sans">
      <main class="pb-12">
        <a routerLink="/tasks" class="inline-block text-[13px] text-ink-soft hover:text-ink hover:underline mb-3">Work board</a>

        @if (error()) { <p class="text-[13px] text-rust mb-3">{{ error() }}</p> }

        @if (task(); as t) {
          <!-- Header: the board row at page size — spine, name, meta line, stamp, ⋯ menu -->
          <div class="paper flex items-stretch gap-4 pr-4 mb-5"
               [style.--c]="divColor(t.divisionId)" [style.--tc]="teamCol(t.teamId)">
            <span class="spine"></span>
            <div class="min-w-0 flex-1 py-4">
              @if (canEdit()) {
                <input [(ngModel)]="editName" (blur)="saveName(t)" aria-label="Task name"
                       class="w-full font-display font-bold text-[28px] leading-[1.15]
                              border border-transparent rounded px-1 -mx-1 outline-none
                              hover:border-line focus:border-ink transition-colors duration-150" />
              } @else {
                <h1 class="font-display font-bold text-[28px] leading-[1.15]">{{ t.name }}</h1>
              }
              <div class="flex items-stretch gap-2.5 mt-1.5 text-[13px] flex-wrap">
                <span class="dtag">{{ lookup.divisionName(t.divisionId) }}</span>
                @if (t.teamId) { <span class="ttag">{{ lookup.teamName(t.teamId) }}</span> }
                <span class="text-ink-soft">{{ shortId(t.id) }}</span>
                <span class="margin-rule"></span>
                <span class="text-ink-soft">for {{ lookup.userName(t.requesterUserId) }}, opened {{ rel(t.createdAt) }} ago</span>
              </div>
            </div>
            <div class="flex items-start gap-2 pt-5 shrink-0">
              <span class="stamp stamp--lg" [class]="stampMod(t)">{{ stamp(t) }}</span>
              <button class="rounded border border-line bg-paper text-[15px] leading-none px-2 py-[5px] text-ink-soft hover:text-ink hover:border-faint"
                      [cdkMenuTriggerFor]="manageMenu" aria-label="More options">⋯</button>
            </div>
          </div>

          <div class="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
            <!-- MAIN -->
            <div class="min-w-0">
              <!-- Description: inline-editable or read-only -->
              <div class="paper p-4 mb-4">
                @if (canEdit()) {
                  <textarea [(ngModel)]="editDescription" (blur)="saveDesc(t)" rows="3" aria-label="Description"
                            class="w-full resize-y border border-transparent rounded p-1 -m-1 text-[15px] leading-[1.55] outline-none
                                   hover:border-line focus:border-ink transition-colors duration-150 placeholder:text-faint"
                            placeholder="Add a description"></textarea>
                } @else {
                  @if (t.description) {
                    <p class="text-[15px] leading-[1.55] whitespace-pre-wrap">{{ t.description }}</p>
                  } @else {
                    <p class="text-[15px] text-ink-soft">No description.</p>
                  }
                }
              </div>

              <button class="w-full rounded bg-accent text-paper font-bold text-[14px] py-3 mb-6
                             hover:bg-accent-ink transition-colors disabled:opacity-50"
                      [disabled]="busy()" (click)="openSubmit(t)">Submit work</button>

              <message-thread #thread [taskId]="t.id" [task]="t"
                [submissions]="submissions()" [questions]="requestTemplate()?.questions ?? []"
                (changed)="refresh()" class="block" />
            </div>

            <!-- RAIL: one sheet — claimants, the margin rule, then details -->
            <aside class="flex flex-col gap-4 lg:sticky lg:top-[72px]">
              <div class="sheet text-[13px]">
                <div class="flex items-center justify-between px-3 py-2">
                  <h2 class="font-display font-bold text-[15px]">Claimant{{ multi(t) ? 's' : '' }}</h2>
                  @if (multi(t)) { <span class="text-ink-soft">{{ claims().length }} of {{ t.openings }}</span> }
                </div>

                @for (c of claims(); track c.userId) {
                  <div class="flex items-center gap-2.5 px-3 py-2">
                    <user-avatar [name]="c.name" [seed]="c.userId" [size]="22" [imageUrl]="lookup.userAvatar(c.userId)" />
                    <span class="flex-1 min-w-0 truncate">{{ c.name }}</span>
                    @if (c.state) {
                      <span class="text-ink-soft shrink-0">@if (c.version !== null) {v{{ c.version }} }{{ c.state }}</span>
                    }
                    @if (isCurrentUser(c.userId)) {
                      <button class="text-ink-soft hover:text-rust hover:underline shrink-0" (click)="leave(t)">Leave</button>
                    } @else if (canEdit()) {
                      <button class="text-ink-soft hover:text-rust hover:underline shrink-0" (click)="evict(t, c.userId)"
                              [attr.aria-label]="'Remove ' + c.name">Remove</button>
                    }
                  </div>
                }

                @for (slot of openPips(t); track $index) {
                  <div class="flex items-center gap-2.5 px-3 py-2">
                    <user-avatar [empty]="true" [size]="22" />
                    <span class="flex-1 text-ink-soft">Open slot</span>
                    <button class="font-bold hover:underline shrink-0" (click)="claim(t)">Claim</button>
                    @if (canEdit()) {
                      <button class="text-ink-soft hover:text-rust hover:underline shrink-0" (click)="removeSlot(t)">Remove</button>
                    }
                  </div>
                }

                @if (canEdit()) {
                  <div class="px-3 py-2">
                    <button class="text-ink-soft hover:text-ink hover:underline" (click)="addOpening(t)">Add slot</button>
                  </div>
                }

                <span class="margin-rule margin-rule--h"></span>

                  <div class="flex items-center justify-between gap-2 px-3 py-2">
                    <span class="text-ink-soft shrink-0">Requester</span>
                    <div class="min-w-0 flex-1 flex justify-end">
                      @if (canEdit()) {
                        <div class="relative">
                          <input [(ngModel)]="requesterQuery" aria-label="Requester"
                                 (focus)="requesterDropOpen.set(true)"
                                 (blur)="onRequesterBlur()"
                                 class="font-bold border border-transparent rounded px-1 -mx-1 py-0.5 -my-0.5 outline-none
                                        hover:border-line focus:border-ink transition-colors text-right w-full max-w-[160px]" />
                          @if (requesterDropOpen() && filteredUsers().length) {
                            <ul class="menu-card absolute right-0 top-full mt-1 w-52 z-10">
                              @for (u of filteredUsers(); track u.id) {
                                <li class="px-3 py-2 hover:bg-paper-hover cursor-pointer flex items-center gap-2"
                                    (mousedown)="selectRequester(t, u)">
                                  <user-avatar [name]="u.displayName" [seed]="u.id" [size]="18" [imageUrl]="u.avatarUrl" />
                                  {{ u.displayName }}
                                </li>
                              }
                            </ul>
                          }
                        </div>
                      } @else {
                        <div class="flex items-center gap-1.5">
                          <user-avatar [name]="lookup.userName(t.requesterUserId)" [seed]="t.requesterUserId" [size]="20" [imageUrl]="lookup.userAvatar(t.requesterUserId)" />
                          <span class="font-bold">{{ lookup.userName(t.requesterUserId) }}</span>
                        </div>
                      }
                    </div>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2">
                    <span class="text-ink-soft">Division</span>
                    <span class="dtag">{{ lookup.divisionName(t.divisionId) }}</span>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2">
                    <span class="text-ink-soft">Team</span>
                    <span>
                      @if (t.teamId) { <span class="ttag">{{ lookup.teamName(t.teamId) }}</span> }
                      @else { <span class="text-ink-soft">None</span> }
                    </span>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2">
                    <span class="text-ink-soft">Task ID</span>
                    <span class="text-ink-soft">{{ shortId(t.id) }}</span>
                  </div>
                  <div class="flex items-center justify-between px-3 py-2">
                    <span class="text-ink-soft">Requested</span>
                    <span>{{ t.createdAt | date: 'mediumDate' }}</span>
                  </div>
              </div>

              <!-- Request template summary -->
              <div>
                <h2 class="font-display font-bold text-[15px] mb-1.5">Request template</h2>
                <div class="sheet text-[13px]">
                  @for (qn of requestTemplate()?.questions ?? []; track qn.id ?? $index) {
                    <div class="flex items-baseline justify-between gap-3 px-3 py-2">
                      <span>{{ qn.prompt }}</span>
                      <span class="text-ink-soft shrink-0">{{ typeLabel(qn.type) }}@if (qn.required) {, required}</span>
                    </div>
                  } @empty {
                    <p class="px-3 py-2 text-ink-soft">No questions. This task is coordination only.</p>
                  }
                </div>
              </div>

              <!-- Mark complete + force/retire menu -->
              <div class="flex rounded border border-line bg-paper overflow-hidden text-[13px]">
                <button class="flex-1 font-bold py-2.5 px-4 transition-colors"
                        [class]="allApproved() ? 'bg-accent text-paper hover:bg-accent-ink' : 'text-ink-soft cursor-not-allowed'"
                        [title]="allApproved() ? '' : 'Every active submission must be approved first'"
                        [disabled]="!allApproved()" (click)="complete(t)">Mark complete</button>
                <button class="border-l border-line px-3 text-ink-soft hover:bg-paper-hover hover:text-ink transition-colors"
                        [cdkMenuTriggerFor]="completeMenu" aria-label="More completion options">▾</button>
              </div>
            </aside>
          </div>
        } @else if (!error()) {
          <p class="text-ink-soft">Loading…</p>
        }
      </main>
    </div>

    <!-- Overflow menu (title-row level) -->
    <ng-template #manageMenu>
      <div class="menu-card" cdkMenu>
        <button cdkMenuItem class="danger" (click)="confirmRetireOpen.set(true)">Retire task…</button>
      </div>
    </ng-template>

    <!-- Complete options menu -->
    <ng-template #completeMenu>
      <div class="menu-card" cdkMenu>
        <button cdkMenuItem (click)="complete(task()!)">Force complete</button>
        <button cdkMenuItem class="danger" (click)="confirmRetireOpen.set(true)">Retire task…</button>
      </div>
    </ng-template>

    <!-- Retire confirmation -->
    @if (confirmRetireOpen()) {
      <div class="tasks-board fixed inset-0 z-50 flex items-center justify-center bg-ink/45"
           (click)="confirmRetireOpen.set(false)">
        <div class="dialog-card p-6 max-w-[400px]" role="alertdialog" aria-labelledby="retire-title"
             (click)="$event.stopPropagation()">
          <h3 id="retire-title" class="font-display font-bold text-[18px] mb-2">Retire this task?</h3>
          <p class="text-[13.5px] text-ink-soft leading-[1.6] mb-5">
            The task and its history become read-only, and claimants can no longer submit work.
            Request template answers are kept but locked. <strong class="text-ink">You can't undo this from the UI.</strong>
          </p>
          <div class="flex gap-2 justify-end text-[13px]">
            <button class="rounded border border-line bg-paper px-3.5 py-2 hover:bg-paper-hover" (click)="confirmRetireOpen.set(false)">Cancel</button>
            <button class="rounded bg-rust text-paper font-bold px-3.5 py-2 hover:opacity-90" (click)="confirmRetire(task()!)">Retire task</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class TaskDetailComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);
  private readonly auth = inject(AuthStore);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly thread = viewChild(MessageThreadComponent);

  readonly task = signal<Task | null>(null);
  readonly requestTemplate = signal<TaskTemplate | null>(null);
  readonly submissions = signal<Submission[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly allUsers = signal<AdminUser[]>([]);
  readonly requesterQuery = signal('');
  readonly requesterDropOpen = signal(false);
  readonly confirmRetireOpen = signal(false);

  editName = '';
  editDescription = '';

  /** Whether the current user can edit task metadata (name, description, requester). */
  readonly canEdit = computed(() => this.auth.canManageOrg());

  /** One row per active claimant (from task.claimantUserIds), submission state overlaid. */
  readonly claims = computed<ClaimRow[]>(() => {
    const t = this.task();
    if (!t) return [];
    const latest = new Map<string, Submission>();
    for (const s of this.submissions()) {
      const cur = latest.get(s.claimantUserId);
      if (!cur || s.submissionNo > cur.submissionNo) latest.set(s.claimantUserId, s);
    }
    return t.claimantUserIds.map((userId) => {
      const sub = latest.get(userId);
      return {
        userId,
        name: this.lookup.userName(userId),
        version: sub?.submissionNo ?? null,
        state: sub?.state ?? null,
      };
    });
  });

  /** True when every claimant has an approved submission. */
  readonly allApproved = computed(() => {
    const cs = this.claims();
    return cs.length > 0 && cs.every((c) => c.state === 'approved');
  });

  /** Users matching the requester search query (top 8). */
  readonly filteredUsers = computed(() => {
    const q = this.requesterQuery().toLowerCase().trim();
    const all = this.allUsers();
    if (!q) return all.slice(0, 8);
    return all.filter((u) =>
      u.displayName.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q),
    ).slice(0, 8);
  });

  // ---- view helpers ----
  divColor(id: string): string { return this.lookup.divisionColor(id); }
  teamCol(id: string | null): string { return this.lookup.teamColor(id); }
  rel(iso: string): string { return relativeTime(iso); }
  shortId(id: string): string { return shortTaskId(id); }
  stamp(t: Task): string { return stampLabel(t.statusCache); }
  stampMod(t: Task): string { return stampClass(t.statusCache); }
  multi(t: Task): boolean { return isMultiClaim(t); }
  openPips(t: Task): unknown[] { return new Array(Math.max(0, t.openings - this.claims().length)); }
  /** Plain-language name for a request template question type. */
  typeLabel(type: QuestionType): string {
    return QUESTION_TYPE_LABELS[type];
  }
  isCurrentUser(userId: string): boolean { return this.auth.user()?.id === userId; }

  ngOnInit(): void {
    void this.lookup.ensureLoaded();
    const id = this.route.snapshot.paramMap.get('id')!;
    void this.load(id);
    if (this.auth.canManageOrg()) {
      void this.api.listUsers().then((u) => this.allUsers.set(u)).catch(() => {});
    }
  }

  private async load(id: string): Promise<void> {
    this.error.set(null);
    try {
      const t = await this.api.getTask(id);
      this.task.set(t);
      this.editName = t.name;
      this.editDescription = t.description ?? '';
      this.requesterQuery.set(this.lookup.userName(t.requesterUserId));
      this.requestTemplate.set(await this.api.getTaskRequestTemplate(id));
      await this.loadSubmissions(id);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** Submissions feed the claim strip; tolerate a 403 (non-reviewers) with an empty strip. */
  private async loadSubmissions(id: string): Promise<void> {
    try {
      this.submissions.set(await this.api.listSubmissions(id));
    } catch {
      this.submissions.set([]);
    }
  }

  /** Run a task mutation, then refresh the header + claim strip from the result. */
  async run(p: Promise<Task>, successMsg?: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const t = await p;
      this.task.set(t);
      this.editName = t.name;
      this.editDescription = t.description ?? '';
      this.requesterQuery.set(this.lookup.userName(t.requesterUserId));
      await this.loadSubmissions(t.id);
      if (successMsg) this.toast.success(successMsg);
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- inline-edit saves ----
  async saveName(t: Task): Promise<void> {
    const name = this.editName.trim();
    if (!name || name === t.name) return;
    await this.run(this.api.updateTask(t.id, { name }));
  }

  async saveDesc(t: Task): Promise<void> {
    const description = this.editDescription;
    if (description === (t.description ?? '')) return;
    await this.run(this.api.updateTask(t.id, { description }));
  }

  // ---- requester combobox ----
  onRequesterBlur(): void {
    setTimeout(() => this.requesterDropOpen.set(false), 150);
  }

  async selectRequester(t: Task, u: AdminUser): Promise<void> {
    this.requesterQuery.set(u.displayName);
    this.requesterDropOpen.set(false);
    await this.run(this.api.changeRequester(t.id, u.id), 'Requester changed');
  }

  // ---- claim-strip actions ----
  claim(t: Task): void { void this.run(this.api.claimTask(t.id), 'Claimed an opening'); }
  leave(t: Task): void { void this.run(this.api.leaveTask(t.id), 'Left the task'); }
  evict(t: Task, userId: string): void { void this.run(this.api.removeClaimant(t.id, userId), 'Claimant removed'); }
  addOpening(t: Task): void { void this.run(this.api.manageClaims(t.id, { openingsDelta: 1 }), 'Slot added'); }
  removeSlot(t: Task): void { void this.run(this.api.manageClaims(t.id, { openingsDelta: -1 }), 'Slot removed'); }
  complete(t: Task): void { void this.run(this.api.completeTask(t.id), 'Task marked complete'); }

  confirmRetire(t: Task): void {
    this.confirmRetireOpen.set(false);
    void this.run(this.api.retireTask(t.id), 'Task retired');
  }

  /** Open the submit-work dialog; refresh task + History when a submission lands. */
  openSubmit(t: Task): void {
    const ref = this.dialog.open<'submitted' | undefined>(SubmitDialogComponent, {
      data: { taskId: t.id, questions: this.requestTemplate()?.questions ?? [] },
      autoFocus: 'dialog',
    });
    ref.closed.subscribe((result) => {
      if (result === 'submitted') void this.refresh();
    });
  }

  /** Re-fetch task + submissions + History after a submit/review. */
  readonly refresh = async (): Promise<void> => {
    const id = this.task()?.id;
    if (!id) return;
    try {
      this.task.set(await this.api.getTask(id));
      await this.loadSubmissions(id);
      await this.thread()?.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  };
}
