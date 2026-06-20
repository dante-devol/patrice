import { z } from 'zod';

/**
 * Task DTOs (Slice 4.1). Creation takes name/description + the target division (and
 * optional team). PATCH is **pure metadata** — only `name`/`description`; `.strict()`
 * turns any other field (e.g. `divisionId`, `openings`, `requesterUserId`) into a 422
 * rather than a silent ignore (overview PATCH convention). Authority/structure changes
 * go through the named action endpoints (/claims, /requester, /questionnaire, /retire).
 */
const name = z.string().trim().min(1, 'Task name is required').max(200);
const description = z.string().max(20_000);
const uuid = z.string().uuid();

export const createTaskSchema = z
  .object({
    name,
    description: description.optional(),
    divisionId: uuid,
    teamId: uuid.optional(),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, {
    message: 'At least one of name/description is required',
  });

export type CreateTaskDto = z.infer<typeof createTaskSchema>;
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

/**
 * Faceted/keyset list query. Each facet accepts a single value or an `in:`-prefixed
 * comma list (`?division=in:<id1>,<id2>`) → string[]. `after` is the keyset cursor
 * (the last seen task id; UUIDv7 PK, newest-first). `limit` defaults to 20, max 100.
 */
function multiFacet(item: z.ZodTypeAny) {
  return z
    .string()
    .optional()
    .transform((v) =>
      v == null ? undefined : v.startsWith('in:') ? v.slice(3).split(',') : [v],
    )
    .pipe(z.array(item).min(1).optional());
}

const statusValue = z.enum(['open', 'claimed', 'review', 'revising', 'approved']);

export const listTasksQuerySchema = z
  .object({
    division: multiFacet(uuid),
    team: multiFacet(uuid),
    status: multiFacet(statusValue),
    requester: multiFacet(uuid),
    claimant: multiFacet(uuid),
    after: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strip();

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

/**
 * Claiming DTOs (Slice 4.2). `/claims` (task:manage_claims) takes an openings delta
 * and/or a claims-closed toggle — at least one must be present. `/requester`
 * (task:change_requester) reassigns the requester to another user.
 */
export const manageClaimsSchema = z
  .object({
    openingsDelta: z.number().int().min(-10_000).max(10_000).optional(),
    claimsClosed: z.boolean().optional(),
  })
  .strict()
  .refine((o) => o.openingsDelta !== undefined || o.claimsClosed !== undefined, {
    message: 'Provide openingsDelta and/or claimsClosed',
  });

export const changeRequesterSchema = z.object({ userId: uuid }).strict();

export type ManageClaimsDto = z.infer<typeof manageClaimsSchema>;
export type ChangeRequesterDto = z.infer<typeof changeRequesterSchema>;
