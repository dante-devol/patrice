import { z } from 'zod';

/**
 * Activity read-list query (admin audit view). Keyset-paginated by `after` (the last
 * seen activity id — UUIDv7, so id-desc ≈ newest-first). All filters are optional and
 * AND-composed:
 *
 *  - `verb`       exact verb match (e.g. `task.created`)
 *  - `verbPrefix` category match (e.g. `task` → `task.*`, `user` → `user.*`/`user_role.*`)
 *  - `actorUserId` the acting user (omit to include system-actored rows)
 *  - `subjectType`/`subjectId` the target entity
 *  - `source`     patrice | integration | system
 *  - `from`/`to`  inclusive createdAt bounds (ISO datetimes)
 */
export const listActivityQuerySchema = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    verb: z.string().min(1).max(100).optional(),
    verbPrefix: z.string().min(1).max(100).optional(),
    actorUserId: z.string().uuid().optional(),
    subjectType: z.string().min(1).max(50).optional(),
    subjectId: z.string().uuid().optional(),
    source: z.enum(['patrice', 'integration', 'system']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strip();

export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;
