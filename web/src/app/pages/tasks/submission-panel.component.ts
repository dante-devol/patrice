import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { LookupStore } from '../../core/lookup.store';
import {
  Question,
  Submission,
  SubmitAnswer,
} from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { isChoiceType, isTextType } from '../../features/questionnaire/questionnaire-form.service';

/**
 * Submission panel (Slice 5). Two faces over the same task, both re-authorized by the
 * API (a non-permitted action surfaces a 403):
 *  - **Answer mode** — a claimant fills the questionnaire and submits / resubmits.
 *  - **Reviewer panel** — each submission with its answers + approve/return/reject and
 *    retire controls, plus its version number and state.
 *
 * Attachment-type answers are display-only here (answer-scoped upload is not yet wired
 * in the web tier); scalar answers (text/numeric/choice) cover the common divisions.
 */
@Component({
  selector: 'submission-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe],
  template: `
    <div class="panel">
      <h3>Submissions</h3>
      @if (error()) { <p class="error">{{ error() }}</p> }

      <!-- Answer mode: fill + submit. -->
      @if (answerable().length > 0) {
        <div class="answer-form">
          <h4>Your answers</h4>
          @for (q of answerable(); track q.id ?? q.prompt) {
            <div class="q-answer">
              <label class="prompt">{{ q.prompt }} @if (q.required) { <span class="req">*</span> }</label>
              @switch (q.type) {
                @case ('detail_text') { <textarea rows="5" [(ngModel)]="model[q.id!]"></textarea> }
                @case ('multiline') { <textarea rows="3" [(ngModel)]="model[q.id!]"></textarea> }
                @case ('text') { <input [(ngModel)]="model[q.id!]" /> }
                @case ('numeric') { <input type="number" [(ngModel)]="model[q.id!]" /> }
                @case ('dropdown') {
                  <select [(ngModel)]="model[q.id!]" [multiple]="!!q.constraints.multi">
                    @for (o of q.constraints.options ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                  </select>
                }
                @case ('radio') {
                  @for (o of q.constraints.options ?? []; track o.value) {
                    <label class="inline">
                      <input type="radio" [name]="q.id ?? ''" [value]="o.value" [(ngModel)]="model[q.id ?? '']" /> {{ o.label }}
                    </label>
                  }
                }
                @case ('attachment') {
                  <span class="muted">Attachment answers aren't editable here yet.</span>
                }
              }
            </div>
          }
          <button (click)="submit()" [disabled]="busy()">Submit</button>
        </div>
      }

      <!-- Reviewer panel: existing submissions. -->
      @for (s of submissions(); track s.id) {
        <div class="submission">
          <div class="row sub-head">
            <strong>v{{ s.submissionNo }}</strong>
            <span class="badge">{{ s.state }}</span>
            <span class="muted">{{ lookup.userName(s.claimantUserId) }} · {{ s.submittedAt | date: 'short' }}</span>
          </div>
          <dl class="answers">
            @for (a of s.answers; track a.id) {
              <div><dt>{{ promptFor(a.questionId) }}</dt><dd>{{ display(a.value) }}</dd></div>
            }
          </dl>
          @if (s.state === 'review') {
            <div class="row review-controls">
              <input class="grow" [(ngModel)]="comment[s.id]" placeholder="Comment / reason" />
              <button class="secondary" (click)="review(s, 'approve')">Approve</button>
              <button class="secondary" (click)="review(s, 'return')">Return</button>
              <button class="secondary" (click)="review(s, 'reject')">Reject</button>
            </div>
          }
          <button class="secondary danger" (click)="retire(s)">Retire submission</button>
        </div>
      } @empty { <p class="muted">No submissions yet.</p> }
    </div>
  `,
  styles: [
    `.answer-form { padding: 10px; background: #0d0f14; border-radius: 7px; margin-bottom: 12px; }
     .q-answer { margin-bottom: 10px; display: flex; flex-direction: column; gap: 4px; }
     .q-answer textarea, .q-answer input, .q-answer select { width: 100%; padding: 8px; background: #11141b; border: 1px solid var(--border); border-radius: 6px; color: var(--text); }
     .inline { display: inline-flex; align-items: center; gap: 6px; margin-right: 12px; }
     .req { color: var(--danger); }
     .submission { border: 1px solid var(--border); border-radius: 7px; padding: 10px; margin-bottom: 10px; }
     .sub-head { justify-content: flex-start; gap: 10px; }
     .answers dt { color: var(--muted); font-size: 12px; }
     .answers dd { margin: 0 0 8px; white-space: pre-wrap; }
     .review-controls { gap: 8px; margin: 8px 0; }
     .review-controls .grow { flex: 1; }
     .danger { color: var(--danger); }`,
  ],
})
export class SubmissionPanelComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly lookup = inject(LookupStore);

  @Input({ required: true }) taskId!: string;
  /** The task's questionnaire questions (answerable scalar types are rendered). */
  @Input() questions: Question[] = [];
  /** Notified after any mutation so the parent can refresh the task header status. */
  @Input() onChanged?: () => void;

  readonly submissions = signal<Submission[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** ngModel bag keyed by question id for the answer form. */
  model: Record<string, unknown> = {};
  /** Per-submission review comment / retire reason. */
  comment: Record<string, string> = {};

  ngOnInit(): void {
    void this.lookup.ensureLoaded();
    void this.reload();
  }

  /** Only scalar question types are answerable in this UI (attachments excluded). */
  answerable(): Question[] {
    return this.questions.filter((q) => q.type !== 'attachment');
  }

  private async reload(): Promise<void> {
    try {
      this.submissions.set(await this.api.listSubmissions(this.taskId));
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  promptFor(questionId: string): string {
    return this.questions.find((q) => q.id === questionId)?.prompt ?? questionId;
  }

  display(value: unknown): string {
    if (value == null) return '—';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const answers: SubmitAnswer[] = this.answerable()
        .map((q) => this.toAnswer(q))
        .filter((a): a is SubmitAnswer => a !== null);
      await this.api.submit(this.taskId, answers);
      this.model = {};
      await this.afterChange();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Map a question's ngModel value to a submit answer, or null when left blank. */
  private toAnswer(q: Question): SubmitAnswer | null {
    const raw = this.model[q.id!];
    if (raw == null || raw === '') return null;
    if (q.type === 'numeric') return { questionId: q.id!, value: Number(raw) };
    if (isChoiceType(q.type)) {
      const selected = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
      return { questionId: q.id!, value: selected };
    }
    if (isTextType(q.type)) return { questionId: q.id!, value: String(raw) };
    return null;
  }

  async review(s: Submission, decision: 'approve' | 'return' | 'reject'): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.reviewSubmission(s.id, decision, this.comment[s.id]?.trim() || undefined);
      await this.afterChange();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async retire(s: Submission): Promise<void> {
    const reason = (this.comment[s.id] ?? '').trim();
    if (reason.length < 5) {
      this.error.set('A retire reason of at least 5 characters is required.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.retireSubmission(s.id, reason);
      await this.afterChange();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async afterChange(): Promise<void> {
    await this.reload();
    this.onChanged?.();
  }
}
