import { z } from 'zod';

/**
 * Notification read-list query. Keyset-paginated by `after`, the opaque `nextCursor`
 * of the previous page; `limit` caps the page. Unread come first, then newest.
 */
export const listNotificationsQuerySchema = z
  .object({
    after: z.string().regex(/^(unread|read):[0-9a-f-]{36}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strip();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
