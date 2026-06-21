import { TestBed } from '@angular/core/testing';
import { FormArray, FormGroup } from '@angular/forms';
import { Question, QuestionType } from '../../core/api.types';
import {
  QUESTION_TYPES,
  QuestionnaireFormService,
  isChoiceType,
  isTextType,
} from './questionnaire-form.service';

/** A minimal Question of `type` with the given constraints. */
function q(type: QuestionType, constraints: Question['constraints'] = {}): Question {
  return { id: type, type, prompt: `${type} prompt`, required: false, constraints };
}

describe('QuestionnaireFormService', () => {
  let svc: QuestionnaireFormService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    svc = TestBed.inject(QuestionnaireFormService);
  });

  it('exposes all seven question types', () => {
    expect(QUESTION_TYPES.map((t) => t.value)).toEqual([
      'detail_text',
      'multiline',
      'text',
      'numeric',
      'dropdown',
      'radio',
      'attachment',
    ]);
  });

  it('classifies text and choice families', () => {
    expect(isTextType('detail_text')).toBe(true);
    expect(isTextType('numeric')).toBe(false);
    expect(isChoiceType('radio')).toBe(true);
    expect(isChoiceType('dropdown')).toBe(true);
    expect(isChoiceType('text')).toBe(false);
  });

  it('newQuestion defaults to a required-prompt text group', () => {
    const g = svc.newQuestion();
    expect(g.get('type')!.value).toBe('text');
    expect(g.get('prompt')!.valid).toBe(false); // prompt is required
  });

  describe('serialize emits only type-relevant constraints', () => {
    const serializeOne = (question: Question) =>
      svc.serialize(svc.authoringForm([question]))[0];

    it('text → min/maxChars only', () => {
      const out = serializeOne(q('text', { minChars: 2, maxChars: 120 }));
      expect(out.type).toBe('text');
      expect(out.constraints).toEqual({ minChars: 2, maxChars: 120 });
    });

    it('numeric → kind + min/max only', () => {
      const out = serializeOne(q('numeric', { kind: 'float', min: 0, max: 10 }));
      expect(out.constraints).toEqual({ kind: 'float', min: 0, max: 10 });
    });

    it('radio → multi + options + min/maxSelect only', () => {
      const out = serializeOne(
        q('radio', {
          multi: true,
          minSelect: 1,
          maxSelect: 2,
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        }),
      );
      expect(out.constraints.options).toEqual([
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]);
      expect(out.constraints.multi).toBe(true);
      expect(out.constraints.minSelect).toBe(1);
      // text/numeric keys must NOT leak onto a choice question.
      expect(out.constraints.maxChars).toBeUndefined();
      expect(out.constraints.kind).toBeUndefined();
    });

    it('attachment → allowedTypes parsed from the comma string', () => {
      const out = serializeOne(q('attachment', { allowedTypes: ['image/png', 'image/jpeg'] }));
      expect(out.constraints.allowedTypes).toEqual(['image/png', 'image/jpeg']);
    });

    it('prunes empty/undefined constraint keys', () => {
      const out = serializeOne(q('text', {}));
      expect(out.constraints).toEqual({});
    });

    it('trims the prompt', () => {
      const question = { ...q('text'), prompt: '  spaced  ' };
      expect(serializeOne(question).prompt).toBe('spaced');
    });
  });

  describe('answerControl enforces per-type validators', () => {
    it('required text is invalid when empty', () => {
      const c = svc.answerControl({ ...q('text'), required: true });
      expect(c.valid).toBe(false);
      c.setValue('something');
      expect(c.valid).toBe(true);
    });

    it('text maxChars enforces maxLength', () => {
      const c = svc.answerControl(q('text', { maxChars: 3 }));
      c.setValue('abcd');
      expect(c.valid).toBe(false);
      c.setValue('abc');
      expect(c.valid).toBe(true);
    });

    it('numeric min/max bounds the value', () => {
      const c = svc.answerControl(q('numeric', { min: 1, max: 5 }));
      c.setValue(0);
      expect(c.valid).toBe(false);
      c.setValue(6);
      expect(c.valid).toBe(false);
      c.setValue(3);
      expect(c.valid).toBe(true);
    });
  });

  it('authoringForm round-trips an existing question set', () => {
    const arr = svc.authoringForm([q('text', { maxChars: 10 }), q('numeric', { min: 0 })]);
    expect(arr).toBeInstanceOf(FormArray);
    expect(arr.length).toBe(2);
    expect(arr.at(0)).toBeInstanceOf(FormGroup);
    const out = svc.serialize(arr);
    expect(out.map((o) => o.type)).toEqual(['text', 'numeric']);
  });
});
