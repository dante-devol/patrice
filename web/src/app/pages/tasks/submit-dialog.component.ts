import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ApiService } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Question, SubmitAnswer } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { isChoiceType, isTextType } from '../../features/questionnaire/questionnaire-form.service';

export interface SubmitDialogData {
  taskId: string;
  questions: Question[];
}

/**
 * Submit-your-work dialog (Slice 5). Replaces the always-open answer form: a claimant
 * fills the questionnaire and submits/resubmits here. The API re-authorizes `task:submit`
 * (a non-claimant gets a 403 → error toast). Returns 'submitted' so the opener refreshes.
 */
@Component({
  selector: 'submit-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="dialog-card tasks-board font-sans p-5">
      <div class="flex items-start justify-between gap-3 mb-4">
        <div>
          <div class="font-mono text-[11px] tracking-[0.16em] uppercase text-ink-soft mb-1">Submit work</div>
          <h2 class="font-serif text-[20px] font-semibold leading-tight">Your answers</h2>
        </div>
        <button class="font-mono text-[18px] leading-none text-ink-soft hover:text-ink -mt-1" (click)="close()" aria-label="Close">×</button>
      </div>

      @if (answerable().length === 0) {
        <p class="text-[14px] text-ink-soft">This is a coordination-only task — nothing to submit.</p>
      } @else {
        @for (q of answerable(); track q.id ?? q.prompt) {
          <div class="flex flex-col gap-1.5 mb-3">
            <label class="text-[13.5px] font-medium">{{ q.prompt }} @if (q.required) { <span class="text-[#99492f]">*</span> }</label>
            @switch (q.type) {
              @case ('detail_text') { <textarea rows="5" [(ngModel)]="model[q.id!]" class="field"></textarea> }
              @case ('multiline') { <textarea rows="3" [(ngModel)]="model[q.id!]" class="field"></textarea> }
              @case ('text') { <input [(ngModel)]="model[q.id!]" class="field" /> }
              @case ('numeric') { <input type="number" [(ngModel)]="model[q.id!]" class="field" /> }
              @case ('dropdown') {
                <select [(ngModel)]="model[q.id!]" [multiple]="!!q.constraints.multi" class="field">
                  @for (o of q.constraints.options ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                </select>
              }
              @case ('radio') {
                @for (o of q.constraints.options ?? []; track o.value) {
                  <label class="inline-flex items-center gap-1.5 mr-4 text-[13.5px]">
                    <input type="radio" [name]="q.id ?? ''" [value]="o.value" [(ngModel)]="model[q.id ?? '']" /> {{ o.label }}
                  </label>
                }
              }
              @case ('attachment') { <span class="text-[13px] text-ink-soft">Attachment answers aren't editable here yet.</span> }
            }
          </div>
        }
      }

      <div class="flex items-center justify-end gap-3 mt-5 pt-4 border-t border-line">
        <button class="font-mono text-[12.5px] text-ink-soft hover:text-ink" (click)="close()">cancel</button>
        <button class="rounded-md bg-accent text-paper font-medium text-[13.5px] px-4 py-2 hover:bg-accent-ink disabled:opacity-50"
                (click)="submit()" [disabled]="busy() || answerable().length === 0">Submit for review</button>
      </div>
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: #fff; border: 1px solid #d3d5cc; border-radius: 6px; color: #191b19; font: inherit; }
     .field:focus-visible { outline: 2px solid #0f7a6b; outline-offset: 1px; }`,
  ],
})
export class SubmitDialogComponent {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly ref = inject<DialogRef<'submitted' | undefined>>(DialogRef);
  readonly data = inject<SubmitDialogData>(DIALOG_DATA);

  readonly busy = signal(false);
  /** ngModel bag keyed by question id. */
  model: Record<string, unknown> = {};

  answerable(): Question[] {
    return this.data.questions.filter((q) => q.type !== 'attachment');
  }

  close(): void {
    this.ref.close(undefined);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const answers = this.answerable()
        .map((q) => this.toAnswer(q))
        .filter((a): a is SubmitAnswer => a !== null);
      await this.api.submit(this.data.taskId, answers);
      this.toast.success('Submitted for review');
      this.ref.close('submitted');
    } catch (e) {
      this.toast.error(errorMessage(e));
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
}
