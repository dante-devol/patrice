import { validateSubmission } from './validate-submission';
import {
  AttachmentLookupPort,
  AttachmentMeta,
  QuestionDef,
  QuestionnaireDef,
} from './questionnaire.types';

/** A stub port over a synthetic attachment table — no storage adapter involved. */
function stubLookup(table: Record<string, AttachmentMeta>): AttachmentLookupPort {
  return (id) => table[id] ?? null;
}

function questionnaire(questions: QuestionDef[]): QuestionnaireDef {
  return { id: 'qn-1', questions };
}

const noAttachments = stubLookup({});

describe('validateSubmission', () => {
  it('happy path — all answers valid → ok', async () => {
    const qn = questionnaire([
      { id: 'q1', ordinal: 0, type: 'text', prompt: 'Name', required: true, constraints: { maxChars: 10 } },
      { id: 'q2', ordinal: 1, type: 'numeric', prompt: 'Score', required: true, constraints: { kind: 'integer', min: 1, max: 10 } },
      { id: 'q3', ordinal: 2, type: 'radio', prompt: 'Pick', required: true, constraints: { multi: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
      { id: 'q4', ordinal: 3, type: 'attachment', prompt: 'File', required: true, constraints: { allowedTypes: ['image/png'] } },
    ]);
    const lookup = stubLookup({ 'att-1': { contentType: 'image/png', kind: 'image' } });
    const result = await validateSubmission(
      qn,
      [
        { questionId: 'q1', text: 'Alice' },
        { questionId: 'q2', number: 7 },
        { questionId: 'q3', selected: ['a'] },
        { questionId: 'q4', attachmentIds: ['att-1'] },
      ],
      lookup,
    );
    expect(result).toEqual({ ok: true });
  });

  it('required-missing → one error per missing required question', async () => {
    const qn = questionnaire([
      { id: 'q1', ordinal: 0, type: 'text', prompt: 'Name', required: true, constraints: {} },
      { id: 'q2', ordinal: 1, type: 'numeric', prompt: 'Score', required: true, constraints: { kind: 'float' } },
      { id: 'q3', ordinal: 2, type: 'text', prompt: 'Optional', required: false, constraints: {} },
    ]);
    const result = await validateSubmission(qn, [{ questionId: 'q1', text: '   ' }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const missing = result.errors.filter((e) => e.code === 'required_missing');
    expect(missing.map((e) => e.questionId).sort()).toEqual(['q1', 'q2']);
    // The optional, unanswered question produces no error.
    expect(result.errors.some((e) => e.questionId === 'q3')).toBe(false);
  });

  it('numeric out-of-range → out_of_range error for min and max bounds', async () => {
    const qn = questionnaire([
      { id: 'lo', ordinal: 0, type: 'numeric', prompt: 'Lo', required: true, constraints: { kind: 'integer', min: 1, max: 10 } },
      { id: 'hi', ordinal: 1, type: 'numeric', prompt: 'Hi', required: true, constraints: { kind: 'integer', min: 1, max: 10 } },
    ]);
    const result = await validateSubmission(
      qn,
      [
        { questionId: 'lo', number: 0 },
        { questionId: 'hi', number: 11 },
      ],
      noAttachments,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.filter((e) => e.code === 'out_of_range').map((e) => e.questionId).sort()).toEqual(['hi', 'lo']);
  });

  it('numeric non-integer → not_integer error', async () => {
    const qn = questionnaire([
      { id: 'n', ordinal: 0, type: 'numeric', prompt: 'N', required: true, constraints: { kind: 'integer', min: 0, max: 100 } },
    ]);
    const result = await validateSubmission(qn, [{ questionId: 'n', number: 3.5 }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'not_integer')).toBe(true);
  });

  it('wrong attachment type → wrong_attachment_type error', async () => {
    const qn = questionnaire([
      { id: 'file', ordinal: 0, type: 'attachment', prompt: 'PNG only', required: true, constraints: { allowedTypes: ['image/png'] } },
    ]);
    const lookup = stubLookup({ 'pdf-1': { contentType: 'application/pdf', kind: 'document' } });
    const result = await validateSubmission(qn, [{ questionId: 'file', attachmentIds: ['pdf-1'] }], lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'wrong_attachment_type')).toBe(true);
  });

  it('attachment matched by coarse kind passes', async () => {
    const qn = questionnaire([
      { id: 'file', ordinal: 0, type: 'attachment', prompt: 'Any image', required: true, constraints: { allowedTypes: ['image'] } },
    ]);
    const lookup = stubLookup({ 'jpg-1': { contentType: 'image/jpeg', kind: 'image' } });
    const result = await validateSubmission(qn, [{ questionId: 'file', attachmentIds: ['jpg-1'] }], lookup);
    expect(result).toEqual({ ok: true });
  });

  it('missing attachment → attachment_not_found', async () => {
    const qn = questionnaire([
      { id: 'file', ordinal: 0, type: 'attachment', prompt: 'File', required: true, constraints: { allowedTypes: [] } },
    ]);
    const result = await validateSubmission(qn, [{ questionId: 'file', attachmentIds: ['ghost'] }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'attachment_not_found')).toBe(true);
  });

  it('choice constraints — single-select rejects multiple, unknown option flagged', async () => {
    const qn = questionnaire([
      { id: 'c', ordinal: 0, type: 'dropdown', prompt: 'Pick one', required: true, constraints: { multi: false, options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] } },
    ]);
    const result = await validateSubmission(qn, [{ questionId: 'c', selected: ['x', 'z'] }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'multi_not_allowed')).toBe(true);
    expect(result.errors.some((e) => e.code === 'invalid_option')).toBe(true);
  });

  it('text too_long is enforced', async () => {
    const qn = questionnaire([
      { id: 't', ordinal: 0, type: 'text', prompt: 'Short', required: true, constraints: { maxChars: 3 } },
    ]);
    const result = await validateSubmission(qn, [{ questionId: 't', text: 'toolong' }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true);
  });

  it('empty questionnaire with no answers → ok (coordination-only division)', async () => {
    const result = await validateSubmission(questionnaire([]), [], noAttachments);
    expect(result).toEqual({ ok: true });
  });

  it('answer for an unknown question → unknown_question', async () => {
    const result = await validateSubmission(questionnaire([]), [{ questionId: 'ghost', text: 'hi' }], noAttachments);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'unknown_question')).toBe(true);
  });
});
