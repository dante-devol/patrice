import {
  Answer,
  AttachmentConstraints,
  AttachmentLookupPort,
  ChoiceConstraints,
  NumericConstraints,
  QuestionDef,
  QuestionnaireDef,
  TextConstraints,
  ValidationErrorEntry,
  ValidationResult,
} from './questionnaire.types';

/**
 * `validateSubmission` — the **pure** answer-validation function (Slice 3). It checks
 * a set of answers against a questionnaire's question constraints and returns a
 * structured error list (never throws on invalid data). Storage is reached only via
 * the injected `AttachmentLookupPort`, so it is unit-testable with a synthetic stub
 * and reused verbatim by Slice 5's `task:submit`.
 *
 * Rules (docs/slices/03-questionnaires.md): every `required` question must be
 * answered; each answer must match its type + constraints; an attachment answer must
 * reference an allowed-type attachment. A non-required, unanswered question is fine.
 */
export async function validateSubmission(
  questionnaire: QuestionnaireDef,
  answers: readonly Answer[],
  attachmentLookup: AttachmentLookupPort,
): Promise<ValidationResult> {
  const errors: ValidationErrorEntry[] = [];
  const byQuestion = new Map<string, Answer>();
  for (const a of answers) byQuestion.set(a.questionId, a);

  // Answers that name a question the questionnaire doesn't have are an integrity
  // error — flag rather than silently ignore.
  const known = new Set(questionnaire.questions.map((q) => q.id));
  for (const a of answers) {
    if (!known.has(a.questionId)) {
      errors.push({
        questionId: a.questionId,
        code: 'unknown_question',
        message: 'Answer references a question not in this questionnaire',
      });
    }
  }

  for (const q of questionnaire.questions) {
    const answer = byQuestion.get(q.id);
    const empty = isEmpty(q, answer);

    if (empty) {
      if (q.required) {
        errors.push({
          questionId: q.id,
          code: 'required_missing',
          message: 'This question is required',
        });
      }
      // Empty + optional ⇒ nothing more to validate.
      continue;
    }

    for (const e of validateAnswer(q, answer!)) errors.push(e);
  }

  // Attachment checks need the async port; run them in a second pass so the
  // synchronous validation above stays simple and order-independent.
  for (const q of questionnaire.questions) {
    if (q.type !== 'attachment') continue;
    const answer = byQuestion.get(q.id);
    if (isEmpty(q, answer)) continue;
    const attachmentErrors = await validateAttachment(
      q,
      answer!,
      attachmentLookup,
    );
    for (const e of attachmentErrors) errors.push(e);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Whether a question is unanswered, per its type's value field. */
function isEmpty(q: QuestionDef, answer: Answer | undefined): boolean {
  if (!answer) return true;
  switch (q.type) {
    case 'detail_text':
    case 'multiline':
    case 'text':
      return answer.text == null || answer.text.trim().length === 0;
    case 'numeric':
      return answer.number == null;
    case 'dropdown':
    case 'radio':
      return !answer.selected || answer.selected.length === 0;
    case 'attachment':
      return !answer.attachmentIds || answer.attachmentIds.length === 0;
  }
}

/** Synchronous, non-attachment per-type validation. */
function validateAnswer(q: QuestionDef, answer: Answer): ValidationErrorEntry[] {
  const errors: ValidationErrorEntry[] = [];
  const err = (code: ValidationErrorEntry['code'], message: string) =>
    errors.push({ questionId: q.id, code, message });

  switch (q.type) {
    case 'detail_text':
    case 'multiline':
    case 'text': {
      if (typeof answer.text !== 'string') {
        err('wrong_type', 'Expected a text answer');
        break;
      }
      const c = q.constraints as TextConstraints;
      const len = answer.text.length;
      if (c.minChars != null && len < c.minChars) {
        err('too_short', `Must be at least ${c.minChars} characters`);
      }
      if (c.maxChars != null && len > c.maxChars) {
        err('too_long', `Must be at most ${c.maxChars} characters`);
      }
      break;
    }
    case 'numeric': {
      if (typeof answer.number !== 'number' || !Number.isFinite(answer.number)) {
        err('wrong_type', 'Expected a numeric answer');
        break;
      }
      const c = q.constraints as NumericConstraints;
      if (c.kind === 'integer' && !Number.isInteger(answer.number)) {
        err('not_integer', 'Must be a whole number');
      }
      if (c.min != null && answer.number < c.min) {
        err('out_of_range', `Must be ≥ ${c.min}`);
      }
      if (c.max != null && answer.number > c.max) {
        err('out_of_range', `Must be ≤ ${c.max}`);
      }
      break;
    }
    case 'dropdown':
    case 'radio': {
      if (!Array.isArray(answer.selected)) {
        err('wrong_type', 'Expected a selection answer');
        break;
      }
      const c = q.constraints as ChoiceConstraints;
      const allowed = new Set((c.options ?? []).map((o) => o.value));
      for (const v of answer.selected) {
        if (!allowed.has(v)) err('invalid_option', `Unknown option "${v}"`);
      }
      if (!c.multi && answer.selected.length > 1) {
        err('multi_not_allowed', 'Only one selection is allowed');
      }
      if (c.minSelect != null && answer.selected.length < c.minSelect) {
        err('too_few_selected', `Select at least ${c.minSelect}`);
      }
      if (c.maxSelect != null && answer.selected.length > c.maxSelect) {
        err('too_many_selected', `Select at most ${c.maxSelect}`);
      }
      break;
    }
    case 'attachment':
      // Handled in the async pass (validateAttachment).
      break;
  }
  return errors;
}

/** Attachment validation — resolves each referenced id via the injected port. */
async function validateAttachment(
  q: QuestionDef,
  answer: Answer,
  lookup: AttachmentLookupPort,
): Promise<ValidationErrorEntry[]> {
  const errors: ValidationErrorEntry[] = [];
  const err = (code: ValidationErrorEntry['code'], message: string) =>
    errors.push({ questionId: q.id, code, message });
  const c = q.constraints as AttachmentConstraints;
  const ids = answer.attachmentIds ?? [];

  if (c.maxFiles != null && ids.length > c.maxFiles) {
    err('too_many_files', `At most ${c.maxFiles} file(s) allowed`);
  }

  const allowed = c.allowedTypes ?? [];
  for (const id of ids) {
    const meta = await lookup(id);
    if (!meta) {
      err('attachment_not_found', `Attachment ${id} not found`);
      continue;
    }
    if (
      allowed.length > 0 &&
      !allowed.includes(meta.contentType) &&
      !allowed.includes(meta.kind)
    ) {
      err(
        'wrong_attachment_type',
        `Attachment type "${meta.contentType}" is not allowed`,
      );
    }
  }
  return errors;
}
