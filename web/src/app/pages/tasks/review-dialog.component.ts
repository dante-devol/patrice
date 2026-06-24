import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { LookupStore } from '../../core/lookup.store';
import { Question, Submission, SubmissionState } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { relativeTime } from './task-presentation';

export interface ReviewDialogData {
  submission: Submission;
  questions: Question[];
}

/**
 * View / review-a-submission dialog (Slice 5). Opened from the "submitted vN" History
 * event: shows the answers, and — while the submission is in review — the approve /
 * return / reject controls with an optional comment (the API re-authorizes `task:review`;
 * self-review is server-gated). Returns 'changed' when a decision lands so the opener
 * refreshes the task + History.
 */
@Component({
  selector: 'review-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="dialog-card tasks-board font-sans p-5">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div class="flex items-center gap-2.5">
          <span class="vchip">v{{ s.submissionNo }}</span>
          <span class="stamp stamp--sm" [class]="stateStamp(s.state)">{{ s.state }}</span>
          <span class="font-mono text-[11.5px] text-ink-soft">{{ lookup.userName(s.claimantUserId) }} · {{ rel(s.submittedAt) }}</span>
        </div>
        <button class="font-mono text-[18px] leading-none text-ink-soft hover:text-ink -mt-1" (click)="close()" aria-label="Close">×</button>
      </div>

      <dl class="text-[14px] mb-2">
        @for (a of s.answers; track a.id) {
          <div class="py-2 border-t border-line/70 first:border-0">
            <dt class="font-mono text-[11px] uppercase tracking-wide text-ink-soft mb-1">{{ promptFor(a.questionId) }}</dt>
            <dd class="m-0 whitespace-pre-wrap leading-relaxed">{{ display(a.value) }}</dd>
          </div>
        } @empty { <p class="text-[13px] text-ink-soft">No answers recorded.</p> }
      </dl>

      @if (s.state === 'review') {
        <div class="mt-4 pt-4 border-t border-line">
          <label class="block font-mono text-[11px] uppercase tracking-wide text-ink-soft mb-1.5">Review note (optional for approve, expected on return/reject)</label>
          <textarea rows="2" [(ngModel)]="comment" class="field mb-3"
                    placeholder="What needs another pass — or a note on approval…"></textarea>
          <div class="flex flex-wrap items-center gap-2">
            <button class="rounded-md bg-accent text-paper text-[13px] font-medium px-3.5 py-1.5 hover:bg-accent-ink disabled:opacity-50"
                    (click)="review('approve')" [disabled]="busy()">Approve</button>
            <button class="rounded-md border border-line text-[13px] px-3.5 py-1.5 hover:border-ink/40 disabled:opacity-50"
                    (click)="review('return')" [disabled]="busy()">Return for revision</button>
            <button class="rounded-md border border-line text-[13px] px-3.5 py-1.5 hover:border-ink/40 disabled:opacity-50"
                    (click)="review('reject')" [disabled]="busy()">Reject</button>
            <span class="flex-1"></span>
            <button class="font-mono text-[11.5px] text-[#99492f] hover:underline disabled:opacity-50"
                    (click)="retire()" [disabled]="busy()">retire submission</button>
          </div>
        </div>
      } @else {
        <div class="mt-4 pt-4 border-t border-line flex justify-end">
          <button class="font-mono text-[12.5px] text-ink-soft hover:text-ink" (click)="close()">close</button>
        </div>
      }
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: #fff; border: 1px solid #d3d5cc; border-radius: 6px; color: #191b19; font: inherit; }
     .field:focus-visible { outline: 2px solid #0f7a6b; outline-offset: 1px; }`,
  ],
})
export class ReviewDialogComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  readonly lookup = inject(LookupStore);
  private readonly ref = inject<DialogRef<'changed' | undefined>>(DialogRef);
  readonly data = inject<ReviewDialogData>(DIALOG_DATA);

  readonly s = this.data.submission;
  readonly busy = signal(false);
  comment = '';

  rel(iso: string): string {
    return relativeTime(iso);
  }
  stateStamp(state: SubmissionState): string {
    return state === 'rejected' ? 'stamp--revising' : `stamp--${state}`;
  }
  promptFor(questionId: string): string {
    return this.data.questions.find((q) => q.id === questionId)?.prompt ?? questionId;
  }
  display(value: unknown): string {
    if (value == null) return '—';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  close(): void {
    this.ref.close(undefined);
  }

  async review(decision: 'approve' | 'return' | 'reject'): Promise<void> {
    this.busy.set(true);
    try {
      await this.api.reviewSubmission(this.s.id, decision, this.comment.trim() || undefined);
      this.toast.success(
        decision === 'approve' ? 'Submission approved' : decision === 'return' ? 'Returned for revision' : 'Submission rejected',
      );
      this.ref.close('changed');
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async retire(): Promise<void> {
    const reason = this.comment.trim();
    if (reason.length < 5) {
      this.toast.error('A retire reason of at least 5 characters is required (use the note field).');
      return;
    }
    this.busy.set(true);
    try {
      await this.api.retireSubmission(this.s.id, reason);
      this.toast.success('Submission retired');
      this.ref.close('changed');
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
