import { z } from 'zod';

/**
 * PUT body for a division's default questionnaire (Slice 3). The question set is
 * replace-in-place: `ordinal` is derived from array order, so callers send an
 * ordered list. An empty array is valid — it authors a zero-question (coordination-
 * only) questionnaire. `constraints` is validated per type via a discriminated union
 * so a numeric range / option list / filetype set can't be attached to the wrong type.
 */

const prompt = z.string().trim().min(1, 'Prompt is required').max(2000);
const required = z.boolean().optional().default(false);

const textConstraints = z
  .object({
    maxChars: z.number().int().positive().optional(),
    minChars: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (c) => c.minChars == null || c.maxChars == null || c.minChars <= c.maxChars,
    { message: 'minChars must not exceed maxChars' },
  );

const numericConstraints = z
  .object({
    kind: z.enum(['integer', 'float']),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict()
  .refine((c) => c.min == null || c.max == null || c.min <= c.max, {
    message: 'min must not exceed max',
  });

const choiceOption = z
  .object({ value: z.string().min(1), label: z.string().min(1) })
  .strict();

const choiceConstraints = z
  .object({
    multi: z.boolean(),
    options: z.array(choiceOption).min(1, 'At least one option is required'),
    minSelect: z.number().int().nonnegative().optional(),
    maxSelect: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (c) => new Set(c.options.map((o) => o.value)).size === c.options.length,
    { message: 'Option values must be unique' },
  )
  .refine(
    (c) => c.minSelect == null || c.maxSelect == null || c.minSelect <= c.maxSelect,
    { message: 'minSelect must not exceed maxSelect' },
  );

const attachmentConstraints = z
  .object({
    allowedTypes: z.array(z.string().min(1)),
    maxBytes: z.number().int().positive().optional(),
    maxFiles: z.number().int().positive().optional(),
  })
  .strict();

function questionOf(type: string, constraints: z.ZodTypeAny) {
  return z
    .object({ type: z.literal(type), prompt, required, constraints })
    .strict();
}

const questionSchema = z.discriminatedUnion('type', [
  questionOf('detail_text', textConstraints),
  questionOf('multiline', textConstraints),
  questionOf('text', textConstraints),
  questionOf('numeric', numericConstraints),
  questionOf('dropdown', choiceConstraints),
  questionOf('radio', choiceConstraints),
  questionOf('attachment', attachmentConstraints),
]);

export const putQuestionnaireSchema = z
  .object({ questions: z.array(questionSchema).max(200) })
  .strict();

export type PutQuestionnaireDto = z.infer<typeof putQuestionnaireSchema>;
export type QuestionInput = z.infer<typeof questionSchema>;
