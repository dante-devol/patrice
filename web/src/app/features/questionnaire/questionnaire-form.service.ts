import { Injectable, inject } from '@angular/core';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  Validators,
} from '@angular/forms';
import {
  Question,
  QuestionConstraints,
  QuestionInput,
  QuestionType,
} from '../../core/api.types';

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: 'detail_text', label: 'Detail Text' },
  { value: 'multiline', label: 'Multiline Text' },
  { value: 'text', label: 'Text' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Radio' },
  { value: 'attachment', label: 'Attachment' },
];

export function isTextType(t: QuestionType): boolean {
  return t === 'detail_text' || t === 'multiline' || t === 'text';
}
export function isChoiceType(t: QuestionType): boolean {
  return t === 'dropdown' || t === 'radio';
}

/**
 * QuestionnaireFormService (application layer, §3.4). The home of the
 * `question[] ↔ Angular Reactive Form` mapping — the form *engine*, kept separate
 * from the presentational renderer. **Authoring** builds a `FormArray` of
 * question-definition groups (one flat group per question, all constraint controls
 * present; `serialize` emits only the keys relevant to a question's type).
 * **Answer** mode (Slice 5) maps a questionnaire's questions to value controls with
 * the per-type validators. Holds no component state, so it is unit-testable headless.
 */
@Injectable({ providedIn: 'root' })
export class QuestionnaireFormService {
  private readonly fb = inject(FormBuilder);

  // ---- Authoring -----------------------------------------------------------

  /** A FormArray of question-definition groups from existing questions. */
  authoringForm(questions: Question[]): FormArray {
    return this.fb.array(questions.map((q) => this.questionGroup(q)));
  }

  /** A blank question-definition group of the given type. */
  newQuestion(type: QuestionType = 'text'): FormGroup {
    return this.questionGroup({ type, prompt: '', required: false, constraints: {} });
  }

  private questionGroup(q: Question | Partial<Question>): FormGroup {
    const c = (q.constraints ?? {}) as QuestionConstraints;
    return this.fb.group({
      type: this.fb.nonNullable.control<QuestionType>(q.type ?? 'text'),
      prompt: this.fb.nonNullable.control(q.prompt ?? '', Validators.required),
      required: this.fb.nonNullable.control(q.required ?? false),
      // text family
      minChars: this.fb.control<number | null>(c.minChars ?? null),
      maxChars: this.fb.control<number | null>(c.maxChars ?? null),
      // numeric
      kind: this.fb.nonNullable.control<'integer' | 'float'>(c.kind ?? 'integer'),
      min: this.fb.control<number | null>(c.min ?? null),
      max: this.fb.control<number | null>(c.max ?? null),
      // choice
      multi: this.fb.nonNullable.control(c.multi ?? false),
      options: this.fb.array((c.options ?? []).map((o) => this.optionGroup(o.value, o.label))),
      minSelect: this.fb.control<number | null>(c.minSelect ?? null),
      maxSelect: this.fb.control<number | null>(c.maxSelect ?? null),
      // attachment (allowedTypes edited as a comma-separated string)
      allowedTypes: this.fb.nonNullable.control((c.allowedTypes ?? []).join(', ')),
      maxFiles: this.fb.control<number | null>(c.maxFiles ?? null),
    });
  }

  optionGroup(value = '', label = ''): FormGroup {
    return this.fb.group({
      value: this.fb.nonNullable.control(value, Validators.required),
      label: this.fb.nonNullable.control(label, Validators.required),
    });
  }

  options(group: FormGroup): FormArray {
    return group.get('options') as FormArray;
  }

  /** Serialize an authoring FormArray into the PUT payload (ordinal = position). */
  serialize(arr: FormArray): QuestionInput[] {
    return arr.controls.map((ctrl) => {
      const g = ctrl as FormGroup;
      const type = g.get('type')!.value as QuestionType;
      return {
        type,
        prompt: (g.get('prompt')!.value as string).trim(),
        required: g.get('required')!.value as boolean,
        constraints: this.constraintsFor(type, g),
      };
    });
  }

  private constraintsFor(type: QuestionType, g: FormGroup): QuestionConstraints {
    const num = (name: string): number | undefined => {
      const v = g.get(name)!.value;
      return v === null || v === '' ? undefined : Number(v);
    };
    if (isTextType(type)) {
      return prune({ minChars: num('minChars'), maxChars: num('maxChars') });
    }
    if (type === 'numeric') {
      return prune({ kind: g.get('kind')!.value as 'integer' | 'float', min: num('min'), max: num('max') });
    }
    if (isChoiceType(type)) {
      const options = (g.get('options') as FormArray).controls.map((o) => ({
        value: (o.get('value')!.value as string).trim(),
        label: (o.get('label')!.value as string).trim(),
      }));
      return prune({ multi: g.get('multi')!.value as boolean, options, minSelect: num('minSelect'), maxSelect: num('maxSelect') });
    }
    // attachment
    const allowedTypes = (g.get('allowedTypes')!.value as string)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return prune({ allowedTypes, maxFiles: num('maxFiles') });
  }

  // ---- Answer mode (consumed by Slice 5; renderer proves all 7 here) -------

  /** A FormGroup keyed by question id, each control carrying its type validators. */
  answerForm(questions: Question[]): FormGroup {
    const group: Record<string, AbstractControl> = {};
    for (const q of questions) group[q.id ?? q.prompt] = this.answerControl(q);
    return this.fb.group(group);
  }

  answerControl(q: Question): FormControl {
    const validators = q.required ? [Validators.required] : [];
    const c = q.constraints;
    if (isTextType(q.type)) {
      if (c.maxChars != null) validators.push(Validators.maxLength(c.maxChars));
      if (c.minChars != null) validators.push(Validators.minLength(c.minChars));
      return this.fb.control('', validators);
    }
    if (q.type === 'numeric') {
      if (c.min != null) validators.push(Validators.min(c.min));
      if (c.max != null) validators.push(Validators.max(c.max));
      return this.fb.control<number | null>(null, validators);
    }
    if (isChoiceType(q.type)) {
      return this.fb.control<string[]>([], validators);
    }
    return this.fb.control<string[]>([], validators); // attachment ids
  }
}

/** Drop undefined keys so constraint bags stay minimal. */
function prune<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
