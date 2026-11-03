import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { LookupStore } from '../../core/lookup.store';
import { Question, Submission, SubmissionState } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { relativeTime, stampClass, stampLabel } from './task-presentation';

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
    <div class="dialog-card tasks-board font-sans">
      <!-- Header: the submission's own row — claimant's version, the task's spine colour, its stamp. -->
      <div class="flex items-start gap-3 border-b border-line">
        <div class="min-w-0 flex-1 px-5 py-4">
          <h2 class="font-display font-bold text-[18px] leading-tight">{{ lookup.userName(s.claimantUserId) }}'s v{{ s.submissionNo }}</h2>
          <p class="text-[13px] text-ink-soft mt-0.5">Submitted {{ rel(s.submittedAt) }} ago</p>
        </div>
        <span class="stamp mt-4" [class]="stateStamp(s.state)">{{ stateLabel(s.state) }}</span>
        <button class="text-[20px] leading-none text-ink-soft hover:text-ink px-4 pt-3.5" (click)="close()" aria-label="Close">×</button>
      </div>

      <div class="sheet border-0 rounded-none text-[14px]">
        @for (a of s.answers; track a.id) {
          <div class="px-5 py-2.5">
            <div class="text-[13px] text-ink-soft">{{ promptFor(a.questionId) }}</div>
            <div class="whitespace-pre-wrap leading-[1.55] mt-0.5" [class.text-faint]="a.value === null || a.value === undefined">{{ display(a.value) }}</div>
          </div>
        } @empty { <p class="px-5 py-3 text-[13px] text-ink-soft">No answers recorded.</p> }
      </div>

      @if (s.state === 'review') {
        <div class="px-5 py-4 border-t border-line">
          <label class="block text-[13px] text-ink-soft mb-1.5" for="review-note">Review note (optional to approve, expected to return or reject)</label>
          <textarea id="review-note" rows="2" [(ngModel)]="comment" class="field mb-3"
                    placeholder="What needs another pass, or a note on approval"></textarea>
          <div class="flex flex-wrap items-center gap-2 text-[13px]">
            <button class="rounded bg-accent text-paper font-bold px-3.5 py-2 hover:bg-accent-ink disabled:opacity-50"
                    (click)="review('approve')" [disabled]="busy()">Approve</button>
            <button class="rounded border border-line bg-paper px-3.5 py-2 hover:bg-paper-hover disabled:opacity-50"
                    (click)="review('return')" [disabled]="busy()">Return for revision</button>
            <button class="px-2 py-2 text-rust hover:underline disabled:opacity-50"
                    (click)="review('reject')" [disabled]="busy()">Reject</button>
            <span class="flex-1"></span>
            <button class="text-ink-soft hover:text-rust hover:underline disabled:opacity-50"
                    (click)="retire()" [disabled]="busy()">Retire submission</button>
          </div>
        </div>
      } @else {
        <div class="px-5 py-3 border-t border-line flex justify-end">
          <button class="rounded border border-line bg-paper text-[13px] px-3.5 py-2 hover:bg-paper-hover" (click)="close()">Close</button>
        </div>
      }
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 2px; color: var(--ink); font: inherit; }
     .field:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }`,
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
    return state === 'rejected' ? 'stamp--lc-retired' : stampClass(state);
  }
  stateLabel(state: SubmissionState): string {
    return state === 'rejected' ? 'Rejected' : stampLabel(state);
  }
  promptFor(questionId: string): string {
    return this.data.questions.find((q) => q.id === questionId)?.prompt ?? questionId;
  }
  display(value: unknown): string {
    if (value == null) return 'Not answered';
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
