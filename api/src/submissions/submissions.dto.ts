import { z } from 'zod';

/**
 * Submission DTOs (Slice 5). A submit carries one entry per answered question — a
 * polymorphic scalar `value` (text/number/choice) and/or `attachmentIds` for an
 * attachment question; the service maps `value` onto the validator's typed answer
 * shape using the question's type. Review takes a decision (+ optional reviewer
 * comment); retire requires a non-empty reason (5..500 chars).
 */
const uuid = z.string().uuid();

const answerSchema = z
  .object({
    questionId: uuid,
    // text | number | selected-option-values; null/absent ⇒ unanswered.
    value: z
      .union([z.string(), z.number(), z.array(z.string())])
      .nullish(),
    attachmentIds: z.array(uuid).max(50).optional(),
  })
  .strict();

export const submitSchema = z
  .object({
    answers: z.array(answerSchema).max(200),
  })
  .strict();

export const reviewSchema = z
  .object({
    decision: z.enum(['approve', 'return', 'reject']),
    comment: z.string().max(20_000).optional(),
  })
  .strict();

export const retireSubmissionSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, 'A reason of at least 5 characters is required')
      .max(500, 'Reason must be at most 500 characters'),
  })
  .strict();

export type SubmitDto = z.infer<typeof submitSchema>;
export type ReviewDto = z.infer<typeof reviewSchema>;
export type RetireSubmissionDto = z.infer<typeof retireSubmissionSchema>;
