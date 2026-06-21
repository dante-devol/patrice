import { Component, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Dialog } from '@angular/cdk/dialog';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import { ApiService } from '../../core/api.service';
import { LookupStore } from '../../core/lookup.store';
import { ToastService } from '../../core/toast.service';
import { Questionnaire, Submission, Task } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { MessageThreadComponent } from './message-thread.component';
import { SubmitDialogComponent } from './submit-dialog.component';
import { UserAvatarComponent } from './user-avatar.component';
import {
  divisionColor,
  isMultiClaim,
  relativeTime,
  stampClass,
  stampStatus,
  teamColor,
} from './task-presentation';

/** One claimant's standing on a task, derived from their latest submission. */
interface ClaimRow {
  userId: string;
  name: string;
  version: number;
  state: string;
}

/**
 * Task detail (Slice 4–5, ui-tailwind). The unified-History main column (description +
 * the {@link MessageThreadComponent} timeline, where submitting and reviewing happen via
 * dialogs and review discussion threads onto the submission event) and a sticky rail
 * holding the **claim strip** (the slot gauge + one row per opening, collapsing to a
 * single assignee for the 1-of-1 norm), the facts, and the questionnaire summary. Every
 * mutation is re-authorized by the API (a non-permitted action surfaces a 403 → toast).
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
          <!-- head -->
          <div class="flex items-start gap-3 mb-1">
            <h1 class="font-serif text-[27px] leading-[1.12] font-semibold flex-1">{{ t.name }}</h1>
            <span class="stamp stamp--lg shrink-0 mt-1" [class]="stampMod(t)">{{ stamp(t) }}</span>
          </div>
          <div class="flex items-center gap-3 flex-wrap mb-5">
            <span class="font-mono text-[12.5px] text-ink-soft">#{{ shortId(t.id) }}</span>
            <span class="text-ink-soft">·</span>
            <span class="dtag" [style.--c]="divColor(lookup.divisionName(t.divisionId))">{{ lookup.divisionName(t.divisionId) }}</span>
            @if (t.teamId) { <span class="ttag" [style.--tc]="teamCol(lookup.teamName(t.teamId))">{{ lookup.teamName(t.teamId) }}</span> }
            <span class="font-mono text-[12.5px] text-ink-soft">requested by {{ lookup.userName(t.requesterUserId) }} · {{ rel(t.createdAt) }}</span>
          </div>

          <div class="grid lg:grid-cols-[1fr_312px] gap-6 items-start">
            <!-- MAIN -->
            <div class="min-w-0">
              <div class="rounded-lg border border-line bg-paper shadow-card p-5 mb-5">
                @if (t.description) {
                  <p class="text-[15px] leading-relaxed whitespace-pre-wrap">{{ t.description }}</p>
                } @else {
                  <p class="text-[15px] text-ink-soft italic">No description.</p>
                }
                <details class="mt-4 group">
                  <summary class="font-mono text-[11.5px] text-ink-soft hover:text-ink cursor-pointer list-none">edit name / description</summary>
                  <div class="mt-3 flex flex-col gap-2">
                    <input [(ngModel)]="editName" class="field" placeholder="Name" />
                    <textarea rows="3" [(ngModel)]="editDescription" class="field" placeholder="Description"></textarea>
                    <div>
                      <button class="rounded-md bg-ink text-paper text-[13px] font-medium px-3.5 py-1.5 disabled:opacity-50"
                              (click)="saveMeta(t)" [disabled]="busy()">Save</button>
                    </div>
                  </div>
                </details>
              </div>

              <message-thread #thread [taskId]="t.id" [task]="t"
                [submissions]="submissions()" [questions]="questionnaire()?.questions ?? []"
                (changed)="refresh()" class="block" />
            </div>

            <!-- RAIL -->
            <aside class="flex flex-col gap-4 lg:sticky lg:top-[72px]">
              <!-- Claim strip -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-4">
                <div class="flex items-center justify-between mb-3">
                  <span class="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-soft">{{ multi(t) ? 'Openings' : 'Assignee' }}</span>
                  @if (multi(t)) {
                    <div class="gauge" [title]="claims().length + ' of ' + t.openings + ' openings filled'">
                      @for (p of filledPips(); track $index) { <span class="pip pip--lg pip--filled"></span> }
                      @for (p of openPips(t); track $index) { <span class="pip pip--lg pip--open"></span> }
                      <span class="gauge-n">{{ claims().length }} of {{ t.openings }}</span>
                    </div>
                  }
                </div>

                @if (claims().length > 0) {
                  <ul class="flex flex-col gap-2 mb-3">
                    @for (c of claims(); track c.userId) {
                      <li class="flex items-center gap-2.5">
                        <user-avatar [name]="c.name" [seed]="c.userId" [size]="24" />
                        <span class="text-[13.5px] font-medium flex-1">{{ c.name }}</span>
                        <span class="font-mono text-[11px]" [style.color]="stateColor(c.state)">v{{ c.version }} · {{ c.state }}</span>
                      </li>
                    }
                  </ul>
                } @else {
                  <div class="flex items-center gap-2.5 mb-3">
                    <user-avatar [empty]="true" [size]="24" />
                    <span class="text-[13.5px] text-ink-soft">Unclaimed — open to claims</span>
                  </div>
                }

                <button class="w-full rounded-md bg-accent text-paper font-medium text-[13.5px] py-2 hover:bg-accent-ink mb-2"
                        (click)="openSubmit(t)">Submit work</button>
                <div class="flex items-center gap-2">
                  <button class="flex-1 rounded-md border border-line text-[13px] px-3 py-1.5 hover:border-ink/40"
                          (click)="claim(t)">Claim an opening</button>
                  <button class="rounded-md border border-line text-[13px] px-3 py-1.5 hover:border-ink/40"
                          (click)="leave(t)">Leave</button>
                  <button class="rounded-md border border-line text-[13px] px-2.5 py-1.5 hover:border-ink/40 font-mono"
                          [cdkMenuTriggerFor]="manageMenu" aria-label="Manage task">⋯</button>
                </div>
              </div>

              <ng-template #manageMenu>
                <div class="menu-card" cdkMenu>
                  <button cdkMenuItem (click)="addOpening(t)"><span class="font-mono text-ink-soft">+</span> Add an opening</button>
                  <button cdkMenuItem (click)="toggleClaims(t)">{{ t.claimsClosed ? 'Reopen claims' : 'Close claims' }}</button>
                  <button cdkMenuItem (click)="complete(t)">Mark complete</button>
                  <button cdkMenuItem class="danger" (click)="retire(t)">Retire task</button>
                </div>
              </ng-template>

              <!-- Facts -->
              <div class="rounded-lg border border-line bg-paper shadow-card p-4">
                <dl class="text-[13px]">
                  <div class="flex items-center justify-between py-1.5">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Division</dt>
                    <dd><span class="dtag" [style.--c]="divColor(lookup.divisionName(t.divisionId))">{{ lookup.divisionName(t.divisionId) }}</span></dd>
                  </div>
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Team</dt>
                    <dd>@if (t.teamId) { <span class="ttag" [style.--tc]="teamCol(lookup.teamName(t.teamId))">{{ lookup.teamName(t.teamId) }}</span> } @else { <span class="text-ink-soft">—</span> }</dd>
                  </div>
                  <div class="flex items-center justify-between py-1.5 border-t border-line/70">
                    <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft">Requester</dt>
                    <dd class="flex items-center gap-1.5">
                      <user-avatar [name]="lookup.userName(t.requesterUserId)" [seed]="t.requesterUserId" [size]="20" />
                      <span class="font-medium">{{ lookup.userName(t.requesterUserId) }}</span>
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
                <div class="mt-3 pt-3 border-t border-line/70 flex items-center gap-2">
                  <input [(ngModel)]="newRequesterId" placeholder="new requester id" class="field text-[12px] flex-1" />
                  <button class="font-mono text-[11.5px] text-ink-soft hover:text-ink" (click)="reassign(t)" [disabled]="!newRequesterId.trim()">change</button>
                </div>
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
            </aside>
          </div>
        } @else if (!error()) {
          <p class="text-ink-soft">Loading…</p>
        }
      </main>
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: #fff; border: 1px solid #d3d5cc; border-radius: 6px; color: #191b19; font: inherit; }
     .field:focus-visible { outline: 2px solid #0f7a6b; outline-offset: 1px; }
     details > summary::-webkit-details-marker { display: none; }`,
  ],
})
export class TaskDetailComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);
  private readonly thread = viewChild(MessageThreadComponent);

  readonly task = signal<Task | null>(null);
  readonly questionnaire = signal<Questionnaire | null>(null);
  readonly submissions = signal<Submission[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  newRequesterId = '';
  editName = '';
  editDescription = '';

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

  // ---- view helpers ----
  divColor(name: string): string {
    return divisionColor(name);
  }
  teamCol(name: string): string {
    return teamColor(name);
  }
  rel(iso: string): string {
    return relativeTime(iso);
  }
  shortId(id: string): string {
    return id.replace(/-/g, '').slice(0, 4);
  }
  stamp(t: Task): string {
    return stampStatus(t.statusCache);
  }
  stampMod(t: Task): string {
    return stampClass(t.statusCache);
  }
  multi(t: Task): boolean {
    return isMultiClaim(t);
  }
  filledPips(): unknown[] {
    return new Array(this.claims().length);
  }
  openPips(t: Task): unknown[] {
    return new Array(Math.max(0, t.openings - this.claims().length));
  }
  shortType(type: string): string {
    return type.replace('_text', '').replace('multiline', 'text');
  }
  stateColor(state: string): string {
    return { review: '#8a6a0c', revising: '#99492f', approved: '#0a5249', rejected: '#99492f' }[state] ?? '#5b605c';
  }

  ngOnInit(): void {
    void this.lookup.ensureLoaded();
    const id = this.route.snapshot.paramMap.get('id')!;
    void this.load(id);
  }

  private async load(id: string): Promise<void> {
    this.error.set(null);
    try {
      const t = await this.api.getTask(id);
      this.task.set(t);
      this.editName = t.name;
      this.editDescription = t.description;
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
      await this.loadSubmissions(t.id);
      if (successMsg) this.toast.success(successMsg);
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- claim-strip actions ----
  claim(t: Task): void {
    void this.run(this.api.claimTask(t.id), 'Claimed an opening');
  }
  leave(t: Task): void {
    void this.run(this.api.leaveTask(t.id), 'Left the task');
  }
  addOpening(t: Task): void {
    void this.run(this.api.manageClaims(t.id, { openingsDelta: 1 }), 'Opening added');
  }
  toggleClaims(t: Task): void {
    void this.run(
      this.api.manageClaims(t.id, { claimsClosed: !t.claimsClosed }),
      t.claimsClosed ? 'Claims reopened' : 'Claims closed',
    );
  }
  complete(t: Task): void {
    void this.run(this.api.completeTask(t.id), 'Task marked complete');
  }
  retire(t: Task): void {
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

  async reassign(t: Task): Promise<void> {
    await this.run(this.api.changeRequester(t.id, this.newRequesterId.trim()), 'Requester changed');
    this.newRequesterId = '';
  }

  async saveMeta(t: Task): Promise<void> {
    await this.run(this.api.updateTask(t.id, { name: this.editName, description: this.editDescription }));
  }

  /** Re-fetch task + submissions + History after a submit/review (status reflects the
   *  min-rule, and the History gains the new submission/decision event). */
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
