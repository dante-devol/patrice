import { z } from 'zod';

/**
 * Request template bodies. A question list is ordered (`ordinal` comes from array
 * order) and may be empty, which is a coordination-only request. On an edit, a
 * question that carries its `id` is kept and updated, one without is added, and any
 * existing question left out is deleted (register E4). `constraints` is validated per
 * type, so a range, option list or file-type set can't be attached to the wrong type.
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
    .object({ id: z.string().uuid().optional(), type: z.literal(type), prompt, required, constraints })
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

export const questionListSchema = z.array(questionSchema).max(200);

/** Replace a task's own questions (diffed by id). */
export const putRequestTemplateSchema = z.object({ questions: questionListSchema }).strict();

const templateName = z.string().trim().min(1, 'Template name is required').max(120);
const templateDescription = z.string().max(2000);

export const createRequestTemplateSchema = z
  .object({
    name: templateName,
    description: templateDescription.optional(),
    isDefault: z.boolean().optional(),
    questions: questionListSchema,
  })
  .strict();

export const updateRequestTemplateSchema = z
  .object({
    name: templateName.optional(),
    description: templateDescription.optional(),
    isDefault: z.boolean().optional(),
    questions: questionListSchema.optional(),
    // The version the client last read; a concurrent edit makes this a 409.
    version: z.number().int().nonnegative(),
  })
  .strict();

export type PutRequestTemplateDto = z.infer<typeof putRequestTemplateSchema>;
export type CreateRequestTemplateDto = z.infer<typeof createRequestTemplateSchema>;
export type UpdateRequestTemplateDto = z.infer<typeof updateRequestTemplateSchema>;
export type QuestionInput = z.infer<typeof questionSchema>;
