import { z } from 'zod';

/**
 * Message DTOs (Slice 4.3). A comment carries markdown `body` and, optionally, a
 * `parentMessageId` making it a one-level reply (the parent must be top-level — the
 * service guards it and a DB trigger backs it up). Attachments are uploaded against
 * an existing message via `POST /attachments` (the attachment exactly-one-owner CHECK
 * requires the owning message to exist at insert), so they aren't referenced here.
 */
const body = z.string().trim().min(1, 'Message body is required').max(50_000);
const uuid = z.string().uuid();

/** A comment: top-level, a reply (`parentMessageId`), or about a submission. */
export const createMessageSchema = z
  .object({ body, parentMessageId: uuid.optional(), submissionId: uuid.optional() })
  .strict()
  .refine((m) => !(m.parentMessageId && m.submissionId), {
    message: 'A reply takes its submission from its parent; send one or the other',
  });

export const updateMessageSchema = z.object({ body }).strict();

export const listMessagesQuerySchema = z
  .object({
    after: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strip();

export type CreateMessageDto = z.infer<typeof createMessageSchema>;
export type UpdateMessageDto = z.infer<typeof updateMessageSchema>;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
