import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AuthStore } from '../../core/auth.store';
import { LookupStore } from '../../core/lookup.store';
import { Message } from '../../core/api.types';
import { errorMessage } from '../../core/errors';

/**
 * The task message thread (Slice 4): top-level comments with one level of replies,
 * a compose box (optional single attachment), per-reply compose, and edit/retire on
 * one's own messages. System messages render senderless. Bodies are shown verbatim
 * (markdown rendering is a follow-up; text is escaped + whitespace-preserved).
 */
@Component({
  selector: 'message-thread',
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="panel">
      <h3>Discussion</h3>
      @if (error()) { <p class="error">{{ error() }}</p> }

      @for (m of messages(); track m.id) {
        <div class="msg" [class.system]="m.kind === 'system'">
          <div class="msg-head">
            <strong>{{ lookup.userName(m.senderUserId) }}</strong>
            <span class="muted">{{ m.createdAt | date: 'short' }}</span>
            @if (m.editedAt) { <span class="muted">(edited)</span> }
            @if (m.lifecycleState === 'retired') { <span class="badge">retired</span> }
          </div>
          <div class="msg-body">{{ m.body }}</div>
          @for (a of m.attachments; track a.id) {
            <a class="attach" [href]="api.attachmentUrl(a.id)" target="_blank" rel="noopener">
              📎 {{ a.filename }} ({{ a.byteSize }} B)
            </a>
          }
          @if (m.kind === 'comment' && m.senderUserId === myId()) {
            <div class="msg-actions">
              <button class="secondary" (click)="startEdit(m)">Edit</button>
              <button class="secondary" (click)="retire(m)">Retire</button>
            </div>
            @if (editingId() === m.id) {
              <div class="compose">
                <textarea rows="2" [(ngModel)]="editBody"></textarea>
                <button (click)="saveEdit(m)">Save</button>
                <button class="secondary" (click)="editingId.set(null)">Cancel</button>
              </div>
            }
          }

          <!-- One level of replies -->
          @for (r of m.replies ?? []; track r.id) {
            <div class="msg reply" [class.system]="r.kind === 'system'">
              <div class="msg-head">
                <strong>{{ lookup.userName(r.senderUserId) }}</strong>
                <span class="muted">{{ r.createdAt | date: 'short' }}</span>
                @if (r.editedAt) { <span class="muted">(edited)</span> }
              </div>
              <div class="msg-body">{{ r.body }}</div>
              @for (a of r.attachments; track a.id) {
                <a class="attach" [href]="api.attachmentUrl(a.id)" target="_blank" rel="noopener">📎 {{ a.filename }}</a>
              }
            </div>
          }

          @if (m.kind === 'comment') {
            <div class="compose reply-box">
              <input [(ngModel)]="replyDrafts[m.id]" placeholder="Reply…" />
              <button class="secondary" (click)="reply(m)" [disabled]="busy() || !replyDrafts[m.id]">Reply</button>
            </div>
          }
        </div>
      } @empty { <p class="muted">No messages yet.</p> }

      @if (nextCursor()) {
        <button class="secondary" (click)="loadMore()" [disabled]="busy()">Load more</button>
      }

      <div class="compose new-message">
        <textarea rows="3" [(ngModel)]="draft" placeholder="Write a message…"></textarea>
        <div class="row">
          <input type="file" (change)="onFile($event)" />
          <button (click)="post()" [disabled]="busy() || !draft.trim()">Post</button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `.msg { border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
     .msg.system { background: #11151c; border-style: dashed; }
     .msg.reply { margin: 8px 0 0 1.5rem; }
     .msg-head { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
     .msg-body { white-space: pre-wrap; margin: 6px 0; }
     .attach { display: inline-block; margin-right: 10px; font-size: 13px; }
     .msg-actions button, .reply-box button { margin-top: 6px; }
     .compose { margin-top: 8px; }
     textarea { width: 100%; padding: 9px 10px; background: #0d0f14; border: 1px solid var(--border); border-radius: 7px; color: var(--text); }
     .new-message { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }`,
  ],
})
export class MessageThreadComponent implements OnInit {
  @Input({ required: true }) taskId!: string;

  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);
  private readonly auth = inject(AuthStore);

  readonly messages = signal<Message[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly editingId = signal<string | null>(null);

  draft = '';
  editBody = '';
  replyDrafts: Record<string, string> = {};
  private pendingFile: File | null = null;

  myId(): string | undefined {
    return this.auth.user()?.id;
  }

  ngOnInit(): void {
    void this.reload();
  }

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
  }

  async post(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const msg = await this.api.createMessage(this.taskId, { body: this.draft.trim() });
      if (this.pendingFile) {
        await this.api.uploadAttachment(msg.id, this.pendingFile);
      }
      this.draft = '';
      this.pendingFile = null;
      await this.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async reply(parent: Message): Promise<void> {
    const body = this.replyDrafts[parent.id]?.trim();
    if (!body) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.createMessage(this.taskId, { body, parentMessageId: parent.id });
      this.replyDrafts[parent.id] = '';
      await this.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
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
      this.error.set(errorMessage(e));
    }
  }

  async retire(m: Message): Promise<void> {
    try {
      await this.api.retireMessage(m.id);
      await this.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
