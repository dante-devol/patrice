/**
 * Shared questionnaire domain types (Slice 3). These mirror the `questionnaire`/
 * `question` schema and the per-type `constraints` jsonb shapes documented in
 * docs/slices/03-questionnaires.md. They are framework-free on purpose: the pure
 * `validateSubmission` (Slice 3, reused verbatim by Slice 5) and the API boundary
 * both speak this vocabulary.
 */

export type QuestionType =
  | 'detail_text'
  | 'multiline'
  | 'text'
  | 'numeric'
  | 'dropdown'
  | 'radio'
  | 'attachment';

/** Text family (`detail_text`/`multiline`/`text`). */
export interface TextConstraints {
  maxChars?: number;
  minChars?: number;
}

export interface NumericConstraints {
  kind: 'integer' | 'float';
  min?: number;
  max?: number;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

/** Selection family (`dropdown`/`radio`). */
export interface ChoiceConstraints {
  multi: boolean;
  options: ChoiceOption[];
  minSelect?: number;
  maxSelect?: number;
}

export interface AttachmentConstraints {
  /** mime types and/or coarse kinds (e.g. 'image', 'audio'); empty ⇒ any. */
  allowedTypes: string[];
  maxBytes?: number;
  maxFiles?: number;
}

export type QuestionConstraints =
  | TextConstraints
  | NumericConstraints
  | ChoiceConstraints
  | AttachmentConstraints
  | Record<string, never>;

export interface QuestionDef {
  id: string;
  ordinal: number;
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: QuestionConstraints;
}

export interface QuestionnaireDef {
  id: string;
  questions: QuestionDef[];
}

/**
 * A single answer. Exactly one value field is populated per question type; an
 * absent/empty field is treated as "unanswered" by the validator. Kept as a flat
 * optional shape so synthetic answers are trivial to construct in tests (Slice 3)
 * and Slice 5 can map a submission row onto it without a discriminated wrapper.
 */
export interface Answer {
  questionId: string;
  text?: string | null;
  number?: number | null;
  /** Selected option `value`s for dropdown/radio. */
  selected?: string[] | null;
  /** Referenced attachment ids for an attachment question. */
  attachmentIds?: string[] | null;
}

/** Attachment metadata the validator needs, resolved via an injected port. */
export interface AttachmentMeta {
  contentType: string;
  kind: string;
}

/**
 * Port resolving an attachment id to its metadata (or null if absent). Slice 3
 * unit-tests with a synthetic stub; Slice 4 implements the storage-backed adapter;
 * Slice 5 wires it through `task:submit`. May be sync or async.
 */
export type AttachmentLookupPort = (
  id: string,
) => AttachmentMeta | null | Promise<AttachmentMeta | null>;

export type ValidationErrorCode =
  | 'unknown_question'
  | 'required_missing'
  | 'wrong_type'
  | 'too_short'
  | 'too_long'
  | 'not_integer'
  | 'out_of_range'
  | 'invalid_option'
  | 'multi_not_allowed'
  | 'too_few_selected'
  | 'too_many_selected'
  | 'too_many_files'
  | 'attachment_not_found'
  | 'wrong_attachment_type';

export interface ValidationErrorEntry {
  questionId: string;
  code: ValidationErrorCode;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationErrorEntry[] };
