import { z } from 'zod';

/**
 * Notification read-list query (Slice 6). Keyset-paginated by `after` (the last seen
 * notification id); `limit` caps the page. Unread-first ordering is applied service-side.
 */
export const listNotificationsQuerySchema = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strip();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
