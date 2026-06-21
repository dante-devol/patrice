import { Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Dialog } from '@angular/cdk/dialog';
import { ApiService } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { LookupStore } from '../../core/lookup.store';
import { ToastService } from '../../core/toast.service';
import { Message, Question, Submission, Task } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { UserAvatarComponent } from './user-avatar.component';
import { ReviewDialogComponent } from './review-dialog.component';
import { HistoryEvent, HistoryReply, avatarColor, buildHistory, relativeTime } from './task-presentation';

/**
 * The unified **History** stream (ui-tailwind). System events and comments share one
 * threaded timeline: each top-level event carries its one-level replies beneath it, so a
 * "submitted vN" event becomes a small thread — the return decision plus discussion sit
 * on the submission, and a "View submission" button opens the review dialog. Comments are
 * threaded the same way (the data model already supports one-level replies). The bottom
 * composer adds new top-level notes. Bodies are shown verbatim (markdown is a follow-up).
 */
@Component({
  selector: 'message-thread',
  standalone: true,
  imports: [FormsModule, UserAvatarComponent, NgTemplateOutlet],
  template: `
    <div class="flex items-center gap-2 mb-3">
      <h2 class="font-mono text-[11.5px] tracking-[0.16em] uppercase text-ink-soft">History</h2>
      <span class="h-px flex-1 bg-line"></span>
      <span class="font-mono text-[11.5px] text-ink-soft">{{ events().length }} events</span>
    </div>

    @if (error()) { <p class="text-[13px] text-[#99492f] mb-3">{{ error() }}</p> }

    <div class="timeline flex flex-col gap-4">
      @for (ev of events(); track ev.id) {
        <div class="ev">
          @if (ev.kind === 'comment' && ev.message; as m) {
            <span class="node node--comment" [style.--who]="who(m.senderUserId)"></span>
            <ng-container [ngTemplateOutlet]="commentCard" [ngTemplateOutletContext]="{ m, small: false }" />
          } @else {
            <span [class]="'node node--' + ev.node"></span>
            <p class="text-[13.5px] flex items-center gap-2 flex-wrap">
              <span>{{ ev.text }}</span>
              <span class="font-mono text-ink-soft text-[12.5px]">· {{ rel(ev.createdAt) }}</span>
              @if (ev.submission) {
                <button class="font-mono text-[11.5px] text-accent-ink border border-line rounded px-2 py-[2px] hover:border-accent/50"
                        (click)="openSubmission(ev)">view submission →</button>
              }
            </p>
          }

          <!-- Thread: this event's one-level replies + a reply composer. -->
          @if (ev.replies.length || canReply(ev)) {
            <div class="mt-2.5 ml-1 border-l border-line pl-3.5 flex flex-col gap-2.5">
              @for (r of ev.replies; track r.id) {
                @if (r.kind === 'comment') {
                  <ng-container [ngTemplateOutlet]="commentCard" [ngTemplateOutletContext]="{ m: r.message, small: true }" />
                } @else {
                  <p class="text-[12.5px] flex items-center gap-2 flex-wrap text-ink-soft">
                    <span class="inline-block w-1.5 h-1.5 rounded-full" [class]="dotClass(r)"></span>
                    <span>{{ r.text }}</span>
                    <span class="font-mono text-[11.5px]">· {{ rel(r.createdAt) }}</span>
                  </p>
                }
              }

              @if (canReply(ev)) {
                @if (openReply() === ev.id) {
                  <div class="composer rounded-lg border border-line bg-paper shadow-card transition-shadow">
                    <textarea rows="2" [(ngModel)]="replyDraft" (keydown.control.enter)="postReply(ev)"
                      [placeholder]="ev.submission ? 'Comment on this submission…' : 'Reply…'"
                      class="w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-relaxed placeholder:text-ink-soft/70 focus:outline-none"></textarea>
                    <div class="flex items-center justify-end gap-2 px-2.5 py-1.5 border-t border-line">
                      <button class="font-mono text-[11px] text-ink-soft hover:text-ink" (click)="openReply.set(null)">cancel</button>
                      <button class="rounded-md bg-ink text-paper text-[12px] font-medium px-3 py-1 hover:bg-ink/90 disabled:opacity-50"
                              (click)="postReply(ev)" [disabled]="busy() || !replyDraft.trim()">Reply</button>
                    </div>
                  </div>
                } @else {
                  <button class="self-start font-mono text-[11px] text-ink-soft hover:text-ink" (click)="startReply(ev)">↳ reply</button>
                }
              }
            </div>
          }
        </div>
      }

      @if (nextCursor()) {
        <div class="ev">
          <span class="node" style="background:#e7e8e1;border-color:#c4c7bd"></span>
          <button class="font-mono text-[12.5px] text-ink-soft hover:text-ink" (click)="loadMore()" [disabled]="busy()">load earlier history →</button>
        </div>
      }

      <!-- new top-level comment -->
      <div class="ev pt-1">
        <span class="node" style="background:#e7e8e1;border-color:#c4c7bd"></span>
        <div class="composer rounded-lg border border-line bg-paper shadow-card transition-shadow">
          <textarea rows="2" [(ngModel)]="draft" (keydown.control.enter)="post()"
            placeholder="Add to the history — a note, a question, a review reply…"
            class="w-full resize-none bg-transparent px-3.5 py-3 text-[14px] leading-relaxed placeholder:text-ink-soft/70 focus:outline-none"></textarea>
          <div class="flex items-center justify-between px-3 py-2 border-t border-line">
            <label class="font-mono text-[11px] text-ink-soft cursor-pointer hover:text-ink">
              <input type="file" class="hidden" (change)="onFile($event)" />
              {{ pendingName() ?? 'attach a file' }}
            </label>
            <button class="rounded-md bg-ink text-paper text-[13px] font-medium px-3.5 py-1.5 hover:bg-ink/90 disabled:opacity-50"
                    (click)="post()" [disabled]="busy() || !draft.trim()">Comment</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Reusable comment card (top-level + reply). -->
    <ng-template #commentCard let-m="m" let-small="small">
      <div class="rounded-lg border border-line bg-paper shadow-card">
        <div class="flex items-center gap-2 px-3.5 border-b border-line" [class.py-2]="!small" [class.py-1.5]="small">
          <user-avatar [name]="lookup.userName(m.senderUserId)" [seed]="m.senderUserId ?? ''" [size]="small ? 18 : 20" />
          <span class="font-medium" [class.text-[13px]]="!small" [class.text-[12.5px]]="small">{{ lookup.userName(m.senderUserId) }}</span>
          <span class="font-mono text-[11.5px] text-ink-soft">{{ roleLabel(m.senderUserId) }}· {{ rel(m.createdAt) }}</span>
          @if (m.editedAt) { <span class="font-mono text-[11px] text-ink-soft">(edited)</span> }
          @if (m.lifecycleState === 'retired') { <span class="vchip">retired</span> }
          <span class="flex-1"></span>
          @if (m.senderUserId === myId() && m.lifecycleState !== 'retired') {
            <button class="font-mono text-[11px] text-ink-soft hover:text-ink" (click)="startEdit(m)">edit</button>
            <button class="font-mono text-[11px] text-ink-soft hover:text-ink" (click)="retire(m)">retire</button>
          }
        </div>
        @if (editingId() === m.id) {
          <div class="px-3.5 py-3">
            <textarea rows="3" [(ngModel)]="editBody"
              class="w-full resize-none bg-board/40 rounded-md border border-line px-3 py-2 text-[14px] leading-relaxed focus:outline-none"></textarea>
            <div class="flex gap-2 mt-2">
              <button class="rounded-md bg-ink text-paper text-[12.5px] font-medium px-3 py-1.5" (click)="saveEdit(m)">Save</button>
              <button class="font-mono text-[12px] text-ink-soft hover:text-ink px-2" (click)="editingId.set(null)">cancel</button>
            </div>
          </div>
        } @else {
          <p class="px-3.5 leading-relaxed whitespace-pre-wrap" [class.py-3]="!small" [class.py-2.5]="small" [class.text-[14px]]="!small" [class.text-[13.5px]]="small">{{ m.body }}</p>
        }
        @for (a of m.attachments; track a.id) {
          <a class="block px-3.5 pb-2 font-mono text-[12px] text-accent-ink hover:underline"
             [href]="api.attachmentUrl(a.id)" target="_blank" rel="noopener">📎 {{ a.filename }}</a>
        }
      </div>
    </ng-template>
  `,
})
export class MessageThreadComponent implements OnInit {
  @Input({ required: true }) taskId!: string;
  /** The owning task, for the synthetic "requested" event + requester role labelling. */
  @Input({ required: true }) task!: Task;
  /** Submissions, to resolve a "submitted vN" event to its Submission for the dialog. */
  @Input() submissions: Submission[] = [];
  /** The task's questionnaire questions, for the review dialog's answer prompts. */
  @Input() questions: Question[] = [];
  /** Fires after a review decision lands so the parent refreshes the task + claim strip. */
  @Output() changed = new EventEmitter<void>();

  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);
  private readonly auth = inject(AuthStore);
  private readonly dialog = inject(Dialog);
  private readonly toast = inject(ToastService);

  readonly messages = signal<Message[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);
  readonly openReply = signal<string | null>(null);
  readonly pendingName = signal<string | null>(null);

  readonly events = computed(() =>
    buildHistory(this.task, this.messages(), (id) => this.lookup.userName(id)),
  );

  draft = '';
  editBody = '';
  replyDraft = '';
  private pendingFile: File | null = null;

  myId(): string | undefined {
    return this.auth.user()?.id;
  }
  who(id: string | null): string {
    return avatarColor(id ?? 'system');
  }
  rel(iso: string): string {
    return relativeTime(iso);
  }
  roleLabel(senderId: string | null): string {
    return senderId && senderId === this.task.requesterUserId ? 'requester ' : '';
  }
  dotClass(r: HistoryReply): string {
    const map: Record<string, string> = { claim: 'bg-[#3f443f]', submit: 'bg-[#8a6a0c]', return: 'bg-[#99492f]', approve: 'bg-accent' };
    return map[r.node] ?? 'bg-[#a7aba3]';
  }
  /** Threads root only at top-level comments and submission events. */
  canReply(ev: HistoryEvent): boolean {
    return !!ev.message && (ev.kind === 'comment' || !!ev.submission);
  }

  ngOnInit(): void {
    void this.reload();
  }

  // ---- submission dialog ----
  private submissionFor(ev: HistoryEvent): Submission | undefined {
    if (!ev.submission) return undefined;
    return this.submissions.find(
      (s) => s.claimantUserId === ev.submission!.actorId && s.submissionNo === ev.submission!.version,
    );
  }

  openSubmission(ev: HistoryEvent): void {
    const submission = this.submissionFor(ev);
    if (!submission) {
      this.toast.error('That submission is no longer available.');
      return;
    }
    const ref = this.dialog.open<'changed' | undefined>(ReviewDialogComponent, {
      data: { submission, questions: this.questions },
      autoFocus: 'dialog',
    });
    ref.closed.subscribe((result) => {
      if (result === 'changed') {
        this.changed.emit();
        void this.reload();
      }
    });
  }

  // ---- replies ----
  startReply(ev: HistoryEvent): void {
    this.replyDraft = '';
    this.openReply.set(ev.id);
  }

  async postReply(ev: HistoryEvent): Promise<void> {
    const body = this.replyDraft.trim();
    if (!body || !ev.message) return;
    this.busy.set(true);
    try {
      await this.api.createMessage(this.taskId, { body, parentMessageId: ev.message.id });
      this.replyDraft = '';
      this.openReply.set(null);
      await this.reload();
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- top-level stream ----
  async reload(): Promise<void> {
    this.busy.set(true);
    try {
      const res = await this.api.listMessages(this.taskId, { limit: 50 });
      this.messages.set(res.items);
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
    try {
      const res = await this.api.listMessages(this.taskId, { after, limit: 50 });
      this.messages.update((cur) => [...cur, ...res.items]);
      this.nextCursor.set(res.nextCursor);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    this.pendingFile = input.files?.[0] ?? null;
    this.pendingName.set(this.pendingFile?.name ?? null);
  }

  async post(): Promise<void> {
    if (!this.draft.trim()) return;
    this.busy.set(true);
    try {
      const msg = await this.api.createMessage(this.taskId, { body: this.draft.trim() });
      if (this.pendingFile) await this.api.uploadAttachment(msg.id, this.pendingFile);
      this.draft = '';
      this.pendingFile = null;
      this.pendingName.set(null);
      await this.reload();
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  startEdit(m: Message): void {
    this.editingId.set(m.id);
    this.editBody = m.body;
  }

  async saveEdit(m: Message): Promise<void> {
    try {
      await this.api.updateMessage(m.id, this.editBody.trim());
      this.editingId.set(null);
      await this.reload();
    } catch (e) {
      this.toast.error(errorMessage(e));
    }
  }

  async retire(m: Message): Promise<void> {
    try {
      await this.api.retireMessage(m.id);
      await this.reload();
    } catch (e) {
      this.toast.error(errorMessage(e));
    }
  }
}
