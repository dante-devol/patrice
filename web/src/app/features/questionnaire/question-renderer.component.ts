import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import { AbstractControl, FormArray, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Question, QuestionType } from '../../core/api.types';
import {
  QUESTION_TYPES,
  QuestionnaireFormService,
  isChoiceType,
  isTextType,
} from './questionnaire-form.service';

/**
 * Questionnaire Renderer (web CONTEXT.md): the single component that walks the seven
 * question types to draw controls, in two modes. **Authoring** binds to a
 * question-definition `FormGroup` (the builder); **Answer** binds a value control to
 * a question definition (Slice 5 submissions). The type switch is identical in both —
 * only the controls drawn differ.
 */
@Component({
  selector: 'question-renderer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    @if (mode === 'authoring' && group) {
      <div class="question-card" [formGroup]="group">
        <div class="row">
          <select formControlName="type" aria-label="Question type">
            @for (t of types; track t.value) { <option [value]="t.value">{{ t.label }}</option> }
          </select>
          <input class="grow" formControlName="prompt" placeholder="Question prompt" />
          <label class="inline"><input type="checkbox" formControlName="required" /> Required</label>
        </div>

        @switch (authoringType()) {
          @case ('text-family') {
            <div class="row constraints">
              <label>Min chars <input type="number" min="0" formControlName="minChars" /></label>
              <label>Max chars <input type="number" min="1" formControlName="maxChars" /></label>
            </div>
          }
          @case ('numeric') {
            <div class="row constraints">
              <label>Kind
                <select formControlName="kind"><option value="integer">integer</option><option value="float">float</option></select>
              </label>
              <label>Min <input type="number" formControlName="min" /></label>
              <label>Max <input type="number" formControlName="max" /></label>
            </div>
          }
          @case ('choice') {
            <div class="constraints">
              <label class="inline"><input type="checkbox" formControlName="multi" /> Allow multiple</label>
              <div class="options" formArrayName="options">
                @for (opt of optionsArray().controls; track $index) {
                  <div class="row" [formGroupName]="$index">
                    <input formControlName="value" placeholder="value" />
                    <input formControlName="label" placeholder="label" />
                    <button type="button" class="secondary" (click)="removeOption($index)">✕</button>
                  </div>
                } @empty { <p class="muted">No options yet.</p> }
                <button type="button" class="secondary" (click)="addOption()">Add option</button>
              </div>
              <div class="row">
                <label>Min select <input type="number" min="0" formControlName="minSelect" /></label>
                <label>Max select <input type="number" min="1" formControlName="maxSelect" /></label>
              </div>
            </div>
          }
          @case ('attachment') {
            <div class="row constraints">
              <label class="grow">Allowed types (comma-separated)
                <input formControlName="allowedTypes" placeholder="image/png, image/jpeg, image" />
              </label>
              <label>Max files <input type="number" min="1" formControlName="maxFiles" /></label>
            </div>
          }
        }
      </div>
    }

    @if (mode === 'answer' && question && control) {
      <div class="question-answer">
        <label class="prompt">{{ question.prompt }} @if (question.required) { <span class="req">*</span> }</label>
        @switch (question.type) {
          @case ('detail_text') { <textarea rows="6" [formControl]="asControl" ></textarea> }
          @case ('multiline') { <textarea rows="3" [formControl]="asControl"></textarea> }
          @case ('text') { <input [formControl]="asControl" /> }
          @case ('numeric') { <input type="number" [formControl]="asControl" /> }
          @case ('dropdown') {
            <select [formControl]="asControl" [multiple]="!!question.constraints.multi">
              @for (o of question.constraints.options ?? []; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
            </select>
          }
          @case ('radio') {
            @for (o of question.constraints.options ?? []; track o.value) {
              <label class="inline">
                <input [type]="question.constraints.multi ? 'checkbox' : 'radio'" [value]="o.value" /> {{ o.label }}
              </label>
            }
          }
          @case ('attachment') {
            <input type="file" disabled [multiple]="(question.constraints.maxFiles ?? 1) > 1" />
            <span class="muted">Upload wired in Slice 5</span>
          }
        }
      </div>
    }
  `,
  styles: [
    `.question-card { border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.5rem; }
     .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 0.4rem; }
     .grow { flex: 1; }
     .inline { display: inline-flex; align-items: center; gap: 0.3rem; }
     .constraints label { display: inline-flex; flex-direction: column; font-size: 0.85rem; }
     .options { margin: 0.4rem 0; padding-left: 0.5rem; border-left: 2px solid #eee; }
     .req { color: #c00; }`,
  ],
})
export class QuestionRendererComponent {
  private readonly forms = inject(QuestionnaireFormService);

  @Input() mode: 'authoring' | 'answer' = 'authoring';
  /** Authoring: the question-definition group. */
  @Input() group?: FormGroup;
  /** Answer: the question definition + the bound value control. */
  @Input() question?: Question;
  @Input() control?: AbstractControl;

  readonly types = QUESTION_TYPES;

  /** Narrowing accessor so the template can bind `[formControl]` to a real control. */
  get asControl() {
    return this.control as import('@angular/forms').FormControl;
  }

  /** Collapse the 7 types into the 4 authoring constraint shapes. */
  authoringType(): 'text-family' | 'numeric' | 'choice' | 'attachment' {
    const t = (this.group?.get('type')?.value as QuestionType) ?? 'text';
    if (isTextType(t)) return 'text-family';
    if (isChoiceType(t)) return 'choice';
    if (t === 'numeric') return 'numeric';
    return 'attachment';
  }

  optionsArray(): FormArray {
    return this.forms.options(this.group!);
  }
  addOption(): void {
    this.optionsArray().push(this.forms.optionGroup());
  }
  removeOption(i: number): void {
    this.optionsArray().removeAt(i);
  }
}
