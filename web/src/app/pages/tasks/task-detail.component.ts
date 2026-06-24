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
import { AdminUser, Questionnaire, Submission, Task } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { MessageThreadComponent } from './message-thread.component';
import { SubmitDialogComponent } from './submit-dialog.component';
import { UserAvatarComponent } from './user-avatar.component';
import { isMultiClaim, relativeTime, stampClass, stampStatus } from './task-presentation';

/** One claimant's standing on a task, derived from their latest submission. */
interface ClaimRow {
  userId: string;
  name: string;
  version: number;
  state: string;
}

/**
 * Task detail (Slice 4–5, ui-tailwind). Unified-History main column with inline-editable
 * title and description, sticky rail with restructured claim strip (Close Claims button,
 * per-slot Claim/Leave icon buttons), facts rail with searchable requester combobox, and
 * a Mark Complete split-button below the Questionnaire panel. Submit Work is a large
 * button at the bottom of the main column. The ⋯ overflow menu lives in the title row.
 */
@Component({
  selector: 'task-detail',
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe, MessageThreadComponent, UserAvatarComponent, CdkMenuTrigger, CdkMenu, CdkMenuItem],
  template: `
    <div class="tasks-board font-sans">
      <main class="pb-12">
        <a routerLink="/tasks" class="inline-flex items-center gap-1.5 font-mono text-[12.5px] text-ink-soft hover:text-ink mb-4">← work board</a>

        @if (error()) { <p class="text-[13px] text-[#99492f] mb-3">{{ error() }}</p> }

        @if (task(); as t) {
          <!-- HEAD: title + stamp + ⋯ overflow menu -->
          <div class="flex items-start gap-3 mb-1">
            @if (canEdit()) {
              <input [(ngModel)]="editName" (blur)="saveName(t)"
                     class="font-serif text-[27px] leading-[1.12] font-semibold flex-1
                            bg-transparent border border-transparent rounded-[5px]
                            px-1 -mx-1 py-0 outline-none
                            hover:border-line focus:border-accent
                            transition-colors duration-150" />
            } @else {
              <h1 class="font-serif text-[27px] leading-[1.12] font-semibold flex-1">{{ t.name }}</h1>
            }
            <span class="stamp stamp--lg shrink-0 mt-1" [class]="stampMod(t)">{{ stamp(t) }}</span>
            <button class="shrink-0 rounded border border-line text-[14px] px-2 py-[7px] hover:border-ink/40 font-mono mt-1 leading-none"
                    [cdkMenuTriggerFor]="manageMenu" aria-label="More options">⋯</button>
          </div>

          <!-- Sub-heading: id, division, team, requester, time -->
          <div class="flex items-center gap-3 flex-wrap mb-5">
            <span class="font-mono text-[12.5px] text-ink-soft">#{{ shortId(t.id) }}</span>
            <span class="text-ink-soft">·</span>
            <span class="dtag" [style.--c]="divColor(t.divisionId)">{{ lookup.divisionName(t.divisionId) }}</span>
            @if (t.teamId) { <span class="ttag" [style.--tc]="teamCol(t.teamId)">{{ lookup.teamName(t.teamId) }}</span> }
            <span class="font-mono text-[12.5px] text-ink-soft">requested by {{ lookup.userName(t.requesterUserId) }} · {{ rel(t.createdAt) }}</span>
          </div>

          <div class="grid lg:grid-cols-[1fr_312px] gap-6 items-start">
            <!-- MAIN -->
            <div class="min-w-0">
              <!-- Description panel: inline-editable or read-only -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-5 mb-5">
                @if (canEdit()) {
                  <textarea [(ngModel)]="editDescription" (blur)="saveDesc(t)"
                            rows="3"
                            class="w-full resize-y bg-transparent border border-transparent rounded-[5px]
                                   p-1 -m-1 text-[15px] leading-relaxed outline-none
                                   hover:border-line focus:border-accent
                                   transition-colors duration-150
                                   placeholder:text-ink-soft/60"
                            placeholder="No description."></textarea>
                } @else {
                  @if (t.description) {
                    <p class="text-[15px] leading-relaxed whitespace-pre-wrap">{{ t.description }}</p>
                  } @else {
                    <p class="text-[15px] text-ink-soft italic">No description.</p>
                  }
                }
              </div>

              <!-- Unified history + comment thread -->
              <message-thread #thread [taskId]="t.id" [task]="t"
                [submissions]="submissions()" [questions]="questionnaire()?.questions ?? []"
                (changed)="refresh()" class="block" />

              <!-- Submit Work — large, prominent, below the history -->
              <div class="mt-5">
                <button class="w-full rounded-lg bg-accent text-paper font-medium text-[15px] py-3.5
                               hover:bg-accent-ink transition-colors disabled:opacity-50"
                        [disabled]="busy()" (click)="openSubmit(t)">Submit work</button>
              </div>
            </div>

            <!-- RAIL -->
            <aside class="flex flex-col gap-4 lg:sticky lg:top-[72px]">

              <!-- Claim strip -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-4">
                <div class="flex items-center justify-between mb-3">
                  <span class="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-soft">
                    {{ multi(t) ? 'Openings' : 'Assignee' }}
                  </span>
                  <div class="flex items-center gap-2">
                    @if (multi(t)) {
                      <div class="gauge" [title]="claims().length + ' of ' + t.openings + ' openings filled'">
                        @for (p of filledPips(); track $index) { <span class="pip pip--lg pip--filled"></span> }
                        @for (p of openPips(t); track $index) { <span class="pip pip--lg pip--open"></span> }
                        <span class="gauge-n">{{ claims().length }}/{{ t.openings }}</span>
                      </div>
                    }
                    <!-- Close Claims: only when there are unfilled open slots and not already closed -->
                    @if (hasOpenSlots(t)) {
                      <button class="font-mono text-[11px] text-ink-soft border border-line rounded px-2 py-[3px] hover:border-ink/40 leading-none"
                              (click)="closeClaims(t)">Close claims</button>
                    }
                  </div>
                </div>

                <!-- Claimant rows; current user gets a Leave icon button -->
                @if (claims().length > 0) {
                  <ul class="flex flex-col gap-2 mb-2">
                    @for (c of claims(); track c.userId) {
                      <li class="flex items-center gap-2.5">
                        <user-avatar [name]="c.name" [seed]="c.userId" [size]="24" />
                        <span class="text-[13.5px] font-medium flex-1 min-w-0 truncate">{{ c.name }}</span>
                        <span class="font-mono text-[11px] shrink-0" [style.color]="stateColor(c.state)">v{{ c.version }}·{{ c.state }}</span>
                        @if (isCurrentUser(c.userId)) {
                          <button class="ml-1 w-6 h-6 flex items-center justify-center rounded border border-line
                                         hover:border-[#99492f] hover:text-[#99492f] text-ink-soft text-[11px] font-mono
                                         shrink-0 transition-colors"
                                  (click)="leave(t)" title="Leave this task">✕</button>
                        }
                      </li>
                    }
                  </ul>
                }

                <!-- Open slots; each gets a Claim icon button -->
                @if (openPips(t).length > 0 && !t.claimsClosed) {
                  <ul class="flex flex-col gap-2 mb-2">
                    @for (slot of openPips(t); track $index) {
                      <li class="flex items-center gap-2.5">
                        <user-avatar [empty]="true" [size]="24" />
                        <span class="text-[13.5px] text-ink-soft flex-1">Open slot</span>
                        <button class="w-6 h-6 flex items-center justify-center rounded border border-line
                                       hover:border-accent hover:text-accent text-ink-soft text-[15px] font-mono
                                       shrink-0 transition-colors"
                                (click)="claim(t)" title="Claim this slot">+</button>
                      </li>
                    }
                  </ul>
                }

                @if (claims().length === 0 && (openPips(t).length === 0 || t.claimsClosed)) {
                  <div class="flex items-center gap-2.5 mb-2">
                    <user-avatar [empty]="true" [size]="24" />
                    <span class="text-[13.5px] text-ink-soft">
                      {{ t.claimsClosed ? 'Claims closed' : 'Unclaimed — open to claims' }}
                    </span>
                  </div>
                }
              </div>

              <!-- Facts -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-4">
                <dl class="text-[13px]">
                  <div class="flex items-center justify-between py-1.5">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Division</dt>
                    <dd><span class="dtag" [style.--c]="divColor(t.divisionId)">{{ lookup.divisionName(t.divisionId) }}</span></dd>
                  </div>
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Team</dt>
                    <dd>
                      @if (t.teamId) {
                        <span class="ttag" [style.--tc]="teamCol(t.teamId)">{{ lookup.teamName(t.teamId) }}</span>
                      } @else {
                        <span class="text-ink-soft">—</span>
                      }
                    </dd>
                  </div>
                  <!-- Requester: searchable combobox for editors, avatar+name for readers -->
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70 gap-2">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft shrink-0">Requester</dt>
                    <dd class="min-w-0 flex-1 flex justify-end">
                      @if (canEdit()) {
                        <div class="relative">
                          <input [(ngModel)]="requesterQuery"
                                 (focus)="requesterDropOpen.set(true)"
                                 (blur)="onRequesterBlur()"
                                 class="text-[12.5px] font-medium bg-transparent border border-transparent rounded-[4px]
                                        px-1 -mx-1 py-0.5 -my-0.5 outline-none
                                        hover:border-line focus:border-accent
                                        transition-colors text-right w-full max-w-[160px]" />
                          @if (requesterDropOpen() && filteredUsers().length) {
                            <ul class="absolute right-0 top-full mt-1 w-52 bg-paper border border-line rounded-lg
                                       shadow-[0_4px_16px_-4px_rgba(25,27,25,0.18)] z-10 overflow-hidden py-1">
                              @for (u of filteredUsers(); track u.id) {
                                <li class="px-3 py-2 text-[12.5px] hover:bg-board cursor-pointer flex items-center gap-2"
                                    (mousedown)="selectRequester(t, u)">
                                  <user-avatar [name]="u.displayName" [seed]="u.id" [size]="18" />
                                  {{ u.displayName }}
                                </li>
                              }
                            </ul>
                          }
                        </div>
                      } @else {
                        <div class="flex items-center gap-1.5">
                          <user-avatar [name]="lookup.userName(t.requesterUserId)" [seed]="t.requesterUserId" [size]="20" />
                          <span class="font-medium">{{ lookup.userName(t.requesterUserId) }}</span>
                        </div>
                      }
                    </dd>
                  </div>
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Status</dt>
                    <dd><span class="stamp stamp--sm" [class]="stampMod(t)">{{ stamp(t) }}</span></dd>
                  </div>
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Requested</dt>
                    <dd class="font-mono text-[12px]">{{ t.createdAt | date: 'mediumDate' }}</dd>
                  </div>
                </dl>
              </div>

              <!-- Questionnaire summary -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-4">
                <div class="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-soft mb-2.5">Questionnaire</div>
                @if (questionnaire()?.questions?.length) {
                  <ul class="flex flex-col gap-2">
                    @for (qn of questionnaire()!.questions; track qn.id ?? $index) {
                      <li class="flex items-start gap-2">
                        <span class="font-mono text-[10px] uppercase tracking-wide text-ink-soft border border-line rounded px-1.5 py-[2px] mt-[1px]">{{ shortType(qn.type) }}</span>
                        <span class="text-[13px]">{{ qn.prompt }} @if (qn.required) { <span class="text-[#99492f]">*</span> }</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="text-[13px] text-ink-soft">Coordination-only task (no questions).</p>
                }
              </div>

              <!-- Mark Complete + Force/Retire dropdown -->
              <div class="flex rounded-lg overflow-hidden border border-line">
                <button class="flex-1 text-[13.5px] font-medium py-2.5 px-4 transition-colors"
                        [class]="allApproved()
                          ? 'bg-accent text-paper hover:bg-accent-ink'
                          : 'bg-paper text-ink-soft cursor-not-allowed'"
                        [title]="allApproved() ? '' : 'All active submissions must be approved first'"
                        [disabled]="!allApproved()" (click)="complete(t)">Mark complete</button>
                <button class="border-l border-line px-3 py-2.5 text-ink-soft hover:bg-board hover:text-ink
                               font-mono text-[13px] transition-colors"
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
        <button cdkMenuItem (click)="addOpening(task()!)">
          <span class="font-mono text-ink-soft">+</span> Add an opening
        </button>
        @if (task()?.claimsClosed) {
          <button cdkMenuItem (click)="toggleClaims(task()!)">Reopen claims</button>
        }
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

    <!-- Retire confirmation overlay (outside .tasks-board so no selector resets) -->
    @if (confirmRetireOpen()) {
      <div class="fixed inset-0 z-50 flex items-center justify-center"
           style="background:rgba(25,27,25,0.38)"
           (click)="confirmRetireOpen.set(false)">
        <div style="background:#fbfbf8;border:1px solid #d3d5cc;border-radius:10px;padding:28px;max-width:380px;width:90%;box-shadow:0 8px 32px -4px rgba(25,27,25,0.22)"
             (click)="$event.stopPropagation()">
          <h3 style="font-family:'IBM Plex Serif',serif;font-size:18px;font-weight:600;margin:0 0 10px">Retire this task?</h3>
          <p style="font-size:13.5px;color:#5b605c;line-height:1.6;margin:0 0 22px">
            The task and its entire history become read-only. Claimants can no longer submit work. Questionnaire answers are preserved but locked. <strong style="color:#191b19;font-weight:500">This cannot be undone via the UI.</strong>
          </p>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button style="padding:8px 16px;background:transparent;border:1px solid #d3d5cc;border-radius:6px;font:inherit;cursor:pointer;color:#191b19;font-size:13.5px"
                    (click)="confirmRetireOpen.set(false)">Cancel</button>
            <button style="padding:8px 16px;background:#99492f;border:1px solid #99492f;border-radius:6px;font:inherit;cursor:pointer;color:#fbfbf8;font-weight:500;font-size:13.5px"
                    (click)="confirmRetire(task()!)">Retire task</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `input.ng-model-title, textarea.ng-model-desc { font: inherit; }`,
  ],
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
  readonly questionnaire = signal<Questionnaire | null>(null);
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

  /** The claim strip: one row per claimant, from their latest submission. */
  readonly claims = computed<ClaimRow[]>(() => {
    const latest = new Map<string, Submission>();
    for (const s of this.submissions()) {
      const cur = latest.get(s.claimantUserId);
      if (!cur || s.submissionNo > cur.submissionNo) latest.set(s.claimantUserId, s);
    }
    return [...latest.values()].map((s) => ({
      userId: s.claimantUserId,
      name: this.lookup.userName(s.claimantUserId),
      version: s.submissionNo,
      state: s.state,
    }));
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
  shortId(id: string): string { return id.replace(/-/g, '').slice(0, 4); }
  stamp(t: Task): string { return stampStatus(t.statusCache); }
  stampMod(t: Task): string { return stampClass(t.statusCache); }
  multi(t: Task): boolean { return isMultiClaim(t); }
  filledPips(): unknown[] { return new Array(this.claims().length); }
  openPips(t: Task): unknown[] { return new Array(Math.max(0, t.openings - this.claims().length)); }
  shortType(type: string): string { return type.replace('_text', '').replace('multiline', 'text'); }
  stateColor(state: string): string {
    return { review: '#8a6a0c', revising: '#99492f', approved: '#0a5249', rejected: '#99492f' }[state] ?? '#5b605c';
  }
  isCurrentUser(userId: string): boolean { return this.auth.user()?.id === userId; }
  hasOpenSlots(t: Task): boolean { return this.claims().length < t.openings && !t.claimsClosed; }

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
      this.questionnaire.set(await this.api.getTaskQuestionnaire(id));
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
  addOpening(t: Task): void { void this.run(this.api.manageClaims(t.id, { openingsDelta: 1 }), 'Opening added'); }
  toggleClaims(t: Task): void {
    void this.run(
      this.api.manageClaims(t.id, { claimsClosed: !t.claimsClosed }),
      t.claimsClosed ? 'Claims reopened' : 'Claims closed',
    );
  }
  closeClaims(t: Task): void {
    const openSlots = t.openings - this.claims().length;
    if (openSlots <= 0) return;
    void this.run(this.api.manageClaims(t.id, { openingsDelta: -openSlots }), 'Open slots removed');
  }
  complete(t: Task): void { void this.run(this.api.completeTask(t.id), 'Task marked complete'); }

  confirmRetire(t: Task): void {
    this.confirmRetireOpen.set(false);
    void this.run(this.api.retireTask(t.id), 'Task retired');
  }

  /** Open the submit-work dialog; refresh task + History when a submission lands. */
  openSubmit(t: Task): void {
    const ref = this.dialog.open<'submitted' | undefined>(SubmitDialogComponent, {
      data: { taskId: t.id, questions: this.questionnaire()?.questions ?? [] },
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
