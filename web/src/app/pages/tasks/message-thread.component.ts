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
import { HistoryEvent, buildHistory, relativeTime } from './task-presentation';

/**
 * The unified **History** stream. System events and comments share one ruled sheet
 * (web/DESIGN.md): each top-level event is a row, and its one-level replies thread inside
 * that row — so a "submitted vN" event carries its return decision and discussion, and
 * "View submission" opens the review dialog. Comments sit in their row with an avatar
 * rather than in nested cards. The last row is the composer for new top-level notes.
 * Bodies are shown verbatim (markdown is a follow-up).
 */
@Component({
  selector: 'message-thread',
  standalone: true,
  imports: [FormsModule, UserAvatarComponent, NgTemplateOutlet],
  template: `
    <div class="flex items-baseline gap-3 mb-1.5">
      <h2 class="font-display font-bold text-[17px]">History</h2>
      <span class="text-[13px] text-ink-soft">{{ events().length }} events</span>
    </div>

    @if (error()) { <p class="text-[13px] text-rust mb-3">{{ error() }}</p> }

    <!-- One ruled sheet: each event is a row; its replies thread inside that row. -->
    <div class="sheet text-[13.5px]">
      @for (ev of events(); track ev.id) {
        <div class="px-3.5 py-2.5">
          @if (ev.kind === 'comment' && ev.message; as m) {
            <ng-container [ngTemplateOutlet]="comment" [ngTemplateOutletContext]="{ m }" />
          } @else {
            <div class="flex items-baseline gap-3">
              <span class="flex-1 min-w-0">
                {{ ev.text }}
                @if (ev.submission) {
                  <button class="ml-1.5 font-bold underline decoration-faint underline-offset-2 hover:decoration-ink"
                          (click)="openSubmission(ev)">View submission</button>
                }
              </span>
              <span class="text-[13px] text-ink-soft shrink-0">{{ rel(ev.createdAt) }}</span>
            </div>
          }

          @if (ev.replies.length || canReply(ev)) {
            <div class="mt-2 ml-[30px] flex flex-col gap-2.5">
              @for (r of ev.replies; track r.id) {
                @if (r.kind === 'comment') {
                  <ng-container [ngTemplateOutlet]="comment" [ngTemplateOutletContext]="{ m: r.message }" />
                } @else {
                  <div class="flex items-baseline gap-3" [class.text-rust]="r.node === 'return'">
                    <span class="flex-1">{{ r.text }}</span>
                    <span class="text-[13px] text-ink-soft shrink-0">{{ rel(r.createdAt) }}</span>
                  </div>
                }
              }

              @if (canReply(ev)) {
                @if (openReply() === ev.id) {
                  <div class="composer rounded border border-line bg-paper">
                    <textarea rows="2" [(ngModel)]="replyDraft" (keydown.control.enter)="postReply(ev)"
                      [placeholder]="ev.submission ? 'Comment on this submission' : 'Reply'"
                      [attr.aria-label]="ev.submission ? 'Comment on this submission' : 'Reply'"
                      class="w-full resize-none px-3 py-2 leading-[1.55] placeholder:text-faint focus:outline-none"></textarea>
                    <div class="flex items-center justify-end gap-4 px-3 py-1.5 border-t border-line text-[13px]">
                      <button class="text-ink-soft hover:text-ink hover:underline" (click)="openReply.set(null)">Cancel</button>
                      <button class="rounded bg-accent text-paper font-bold px-3 py-1 hover:bg-accent-ink disabled:opacity-50"
                              (click)="postReply(ev)" [disabled]="busy() || !replyDraft.trim()">Reply</button>
                    </div>
                  </div>
                } @else {
                  <button class="self-start text-[13px] text-ink-soft hover:text-ink hover:underline" (click)="startReply(ev)">Reply</button>
                }
              }
            </div>
          }
        </div>
      }

      @if (nextCursor()) {
        <div class="px-3.5 py-2.5">
          <button class="text-[13px] text-ink-soft hover:text-ink hover:underline" (click)="loadMore()" [disabled]="busy()">Load earlier history</button>
        </div>
      }

      <!-- New top-level comment: the sheet's last row. -->
      <div class="px-3.5 py-3">
        <div class="composer rounded border border-line bg-paper">
          <textarea rows="2" [(ngModel)]="draft" (keydown.control.enter)="post()" aria-label="Add a comment"
            placeholder="Add a note or question"
            class="w-full resize-none px-3 py-2.5 text-[14px] leading-[1.55] placeholder:text-faint focus:outline-none"></textarea>
          <div class="flex items-center justify-between px-3 py-1.5 border-t border-line text-[13px]">
            <label class="cursor-pointer text-ink-soft hover:text-ink hover:underline">
              <input type="file" class="hidden" (change)="onFile($event)" />
              {{ pendingName() ?? 'Attach a file' }}
            </label>
            <button class="rounded border border-line bg-paper font-bold px-3 py-1 hover:bg-paper-hover disabled:opacity-50"
                    (click)="post()" [disabled]="busy() || !draft.trim()">Comment</button>
          </div>
        </div>
      </div>
    </div>

    <!-- A comment (top-level or reply): avatar, name, body — inside its row, not a card. -->
    <ng-template #comment let-m="m">
      <div class="grid grid-cols-[22px_1fr] gap-x-2">
        <user-avatar [name]="lookup.userName(m.senderUserId)" [seed]="m.senderUserId ?? ''" [size]="22" [imageUrl]="lookup.userAvatar(m.senderUserId)" />
        <div class="min-w-0">
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="font-bold">{{ lookup.userName(m.senderUserId) }}</span>
            @if (isRequester(m.senderUserId)) { <span class="text-[13px] text-ink-soft">requester</span> }
            @if (m.editedAt) { <span class="text-[13px] text-ink-soft">edited</span> }
            @if (m.lifecycleState === 'retired') { <span class="vchip">Retired</span> }
            <span class="flex-1"></span>
            @if (m.senderUserId === myId() && m.lifecycleState !== 'retired') {
              <button class="text-[13px] text-ink-soft hover:text-ink hover:underline" (click)="startEdit(m)">Edit</button>
              <button class="text-[13px] text-ink-soft hover:text-rust hover:underline" (click)="retire(m)">Retire</button>
            }
            <span class="text-[13px] text-ink-soft">{{ rel(m.createdAt) }}</span>
          </div>
          @if (editingId() === m.id) {
            <textarea rows="3" [(ngModel)]="editBody" aria-label="Edit comment"
              class="w-full resize-none rounded border border-line bg-paper px-3 py-2 mt-1.5 text-[14px] leading-[1.55] focus:outline-none focus:border-ink"></textarea>
            <div class="flex items-center gap-4 mt-1.5 text-[13px]">
              <button class="rounded bg-accent text-paper font-bold px-3 py-1 hover:bg-accent-ink" (click)="saveEdit(m)">Save</button>
              <button class="text-ink-soft hover:text-ink hover:underline" (click)="editingId.set(null)">Cancel</button>
            </div>
          } @else {
            <p class="mt-0.5 text-[14px] leading-[1.55] whitespace-pre-wrap">{{ m.body }}</p>
          }
          @for (a of m.attachments; track a.id) {
            <a class="block mt-1 text-[13px] font-bold underline decoration-faint underline-offset-2 hover:decoration-ink"
               [href]="api.attachmentUrl(a.id)" target="_blank" rel="noopener">{{ a.filename }}</a>
          }
        </div>
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
  /** The task's request template questions, for the review dialog's answer prompts. */
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
  rel(iso: string): string {
    return relativeTime(iso);
  }
  isRequester(senderId: string | null): boolean {
    return !!senderId && senderId === this.task.requesterUserId;
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
