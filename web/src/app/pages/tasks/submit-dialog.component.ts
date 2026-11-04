import { TasksApi } from '../../core/api/work.api';
import { firstValueFrom } from 'rxjs';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ToastService } from '../../core/toast.service';
import { Question, SubmitAnswer } from '../../core/api.types';
import { errorMessage } from '../../core/errors';
import { isChoiceType, isTextType } from '../../features/request-template/request-template-form.service';
import { validateSubmission } from '../../core/validation/validate-submission';
import type { Answer, AttachmentMeta, QuestionDef } from '../../core/validation/request-template.types';

/** A file uploaded for an answer, waiting for the submit to claim it. */
interface Upload {
  id: string;
  filename: string;
  meta: AttachmentMeta;
}

export interface SubmitDialogData {
  taskId: string;
  questions: Question[];
}

/**
 * Submit-your-work dialog. A claimant answers the task's questions — files included:
 * each is uploaded as it's chosen and claimed by the submit — and the answers are
 * checked by the same validator the API runs before they're sent. The API
 * re-authorizes `task:submit`. Returns 'submitted' so the opener refreshes.
 */
@Component({
  selector: 'submit-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="dialog-card tasks-board font-sans">
      <div class="flex items-start gap-3 border-b border-line">
        <div class="flex-1 px-5 py-4">
          <h2 class="font-display font-bold text-[18px] leading-tight">Submit work</h2>
          <p class="text-[13px] text-ink-soft mt-0.5">Answer the request template, then submit it for review.</p>
        </div>
        <button class="text-[20px] leading-none text-ink-soft hover:text-ink px-4 pt-3.5" (click)="close()" aria-label="Close">×</button>
      </div>

      <div class="px-5 py-4">
        @if (answerable().length === 0) {
          <p class="text-[14px] text-ink-soft">This task is coordination only, so there's nothing to submit.</p>
        } @else {
          @for (q of answerable(); track q.id ?? q.prompt) {
            <div class="flex flex-col gap-1.5 mb-3.5">
              <label class="text-[13px] font-bold" [attr.for]="'q-' + q.id">{{ q.prompt }}@if (q.required) { <span class="text-ink-soft font-normal">, required</span> }</label>
              @switch (q.type) {
                @case ('detail_text') { <textarea [id]="'q-' + q.id" rows="5" [(ngModel)]="model[q.id!]" class="field"></textarea> }
                @case ('multiline') { <textarea [id]="'q-' + q.id" rows="3" [(ngModel)]="model[q.id!]" class="field"></textarea> }
                @case ('text') { <input [id]="'q-' + q.id" [(ngModel)]="model[q.id!]" class="field" /> }
                @case ('numeric') { <input [id]="'q-' + q.id" type="number" [(ngModel)]="model[q.id!]" class="field" /> }
                @case ('dropdown') {
                  <select [id]="'q-' + q.id" [(ngModel)]="model[q.id!]" [multiple]="!!q.constraints.multi" class="field">
                    @for (o of q.constraints.options ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                  </select>
                }
                @case ('radio') {
                  <div>
                    @for (o of q.constraints.options ?? []; track o.value) {
                      <label class="inline-flex items-center gap-1.5 mr-4 text-[13.5px]">
                        <input type="radio" [name]="q.id ?? ''" [value]="o.value" [(ngModel)]="model[q.id ?? '']" /> {{ o.label }}
                      </label>
                    }
                  </div>
                }
                @case ('attachment') {
                  <div>
                    <input [id]="'q-' + q.id" type="file" [multiple]="(q.constraints.maxFiles ?? 1) > 1"
                           [attr.accept]="accept(q)" (change)="addFiles(q, $event)" [disabled]="busy()" />
                    @for (u of uploads[q.id!] ?? []; track u.id) {
                      <div class="flex items-center gap-2 mt-1 text-[13px]">
                        <span class="truncate">{{ u.filename }}</span>
                        <button class="text-ink-soft hover:text-rust hover:underline" (click)="removeFile(q, u)">Remove</button>
                      </div>
                    }
                  </div>
                }
              }
              @for (e of errorsFor(q); track e) { <span class="text-[12.5px] text-rust">{{ e }}</span> }
            </div>
          }
        }
      </div>

      <div class="flex items-center justify-end gap-4 px-5 py-3 border-t border-line text-[13px]">
        <button class="text-ink-soft hover:text-ink hover:underline" (click)="close()">Cancel</button>
        <button class="rounded bg-accent text-paper font-bold px-3.5 py-2 hover:bg-accent-ink disabled:opacity-50"
                (click)="submit()" [disabled]="busy() || answerable().length === 0">Submit for review</button>
      </div>
    </div>
  `,
  styles: [
    `.field { width: 100%; padding: 8px 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 2px; color: var(--ink); font: inherit; }
     .field:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }`,
  ],
})
export class SubmitDialogComponent {
  private readonly tasksApi = inject(TasksApi);
  private readonly toast = inject(ToastService);
  private readonly ref = inject<DialogRef<'submitted' | undefined>>(DialogRef);
  readonly data = inject<SubmitDialogData>(DIALOG_DATA);

  readonly busy = signal(false);
  readonly errors = signal<Record<string, string[]>>({});
  /** ngModel bag keyed by question id. */
  model: Record<string, unknown> = {};
  /** Uploaded files per attachment question. */
  uploads: Record<string, Upload[]> = {};

  answerable(): Question[] {
    return this.data.questions;
  }

  errorsFor(q: Question): string[] {
    return this.errors()[q.id!] ?? [];
  }

  /** The file picker's filter, from the question's allowed types (coarse kinds pass). */
  accept(q: Question): string | null {
    const types = q.constraints.allowedTypes ?? [];
    return types.length ? types.map((t) => (t.includes('/') ? t : `${t}/*`)).join(',') : null;
  }

  async addFiles(q: Question, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.busy.set(true);
    try {
      for (const file of files) {
        const meta = await firstValueFrom(this.tasksApi.uploadForAnswer(this.data.taskId, file));
        const list = this.uploads[q.id!] ?? [];
        this.uploads[q.id!] = [
          ...list,
          { id: meta.id, filename: meta.filename, meta: { contentType: meta.contentType, kind: meta.kind, byteSize: meta.byteSize } },
        ];
      }
    } catch (e) {
      this.toast.error(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Drop a file from the answer; the unclaimed upload is collected later. */
  removeFile(q: Question, u: Upload): void {
    this.uploads[q.id!] = (this.uploads[q.id!] ?? []).filter((x) => x.id !== u.id);
  }

  close(): void {
    this.ref.close(undefined);
  }

  async submit(): Promise<void> {
    const answers = this.answerable()
      .map((q) => this.toAnswer(q))
      .filter((a): a is SubmitAnswer => a !== null);
    if (!(await this.check(answers))) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.tasksApi.submit(this.data.taskId, answers));
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
    if (q.type === 'attachment') {
      const ids = (this.uploads[q.id!] ?? []).map((u) => u.id);
      return ids.length ? { questionId: q.id!, attachmentIds: ids } : null;
    }
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

  /** Run the API's own validator here first, so mistakes show next to their question. */
  private async check(answers: SubmitAnswer[]): Promise<boolean> {
    const metaById = new Map(Object.values(this.uploads).flat().map((u) => [u.id, u.meta]));
    const defs: QuestionDef[] = this.data.questions.map((q) => ({ ...q, id: q.id!, constraints: q.constraints as never }));
    const typed: Answer[] = answers.map((a) => {
      const q = this.data.questions.find((x) => x.id === a.questionId)!;
      if (q.type === 'attachment') return { questionId: a.questionId, attachmentIds: a.attachmentIds ?? null };
      if (q.type === 'numeric') return { questionId: a.questionId, number: a.value as number };
      if (isChoiceType(q.type)) return { questionId: a.questionId, selected: a.value as string[] };
      return { questionId: a.questionId, text: a.value as string };
    });
    const result = await validateSubmission({ id: this.data.taskId, questions: defs }, typed, (id) => metaById.get(id) ?? null);
    const byQuestion: Record<string, string[]> = {};
    if (!result.ok) for (const e of result.errors) (byQuestion[e.questionId] ??= []).push(e.message);
    this.errors.set(byQuestion);
    return result.ok;
  }
}
