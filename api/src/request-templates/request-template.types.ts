/**
 * Request template domain types: questions and the per-type `constraints` shapes.
 * Framework-free on purpose — the pure `validateSubmission` and the API boundary both
 * speak this vocabulary, and the web keeps a generated copy (`contract:emit`).
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

export interface RequestTemplateDef {
  id: string;
  questions: QuestionDef[];
}

/**
 * A single answer. Exactly one value field is populated per question type; an
 * absent/empty field is treated as "unanswered" by the validator. Kept as a flat
 * optional shape so answers are simple to build in tests and from a submission
 * row, with no discriminated wrapper.
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
  /** Checked against `maxBytes` when known. */
  byteSize?: number;
}

/**
 * Port resolving an attachment id to its metadata (or null if absent). The
 * submit path resolves only the submitter's own pending uploads; tests use a stub.
 * May be sync or async.
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
  | 'wrong_attachment_type'
  | 'file_too_large';

export interface ValidationErrorEntry {
  questionId: string;
  code: ValidationErrorCode;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationErrorEntry[] };
