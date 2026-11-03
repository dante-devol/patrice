import { z } from 'zod';

/**
 * Grant (permission-matrix cell) DTOs. A grant is its action + scope + effect, so
 * unlike pure-metadata PATCH targets, `PATCH /grants/:id` legitimately edits those
 * fields — each edit re-validates and re-projects (validate-before-activate).
 *
 * The five Scope Shapes (api/CONTEXT.md): `global`, `specific_division`/
 * `specific_team`, `own_division`/`own_team`, `own`, `role`. The matrix UI shows a
 * single `own` concept; the projector picks the Own-Family template per action.
 */
export const scopeKindSchema = z.enum([
  'global',
  'specific_division',
  'specific_team',
  'own_division',
  'own_team',
  'own',
  'role',
]);

export const createGrantSchema = z
  .object({
    roleId: z.string().uuid(),
    action: z.string().min(1),
    effect: z.enum(['permit', 'forbid']).default('permit'),
    scopeKind: scopeKindSchema,
    scopeDivisionId: z.string().uuid().nullish(),
    scopeTeamId: z.string().uuid().nullish(),
    scopeRoleId: z.string().uuid().nullish(),
  })
  .strict();

export const updateGrantSchema = z
  .object({
    action: z.string().min(1).optional(),
    effect: z.enum(['permit', 'forbid']).optional(),
    scopeKind: scopeKindSchema.optional(),
    scopeDivisionId: z.string().uuid().nullish(),
    scopeTeamId: z.string().uuid().nullish(),
    scopeRoleId: z.string().uuid().nullish(),
  })
  .strict();

export type CreateGrantDto = z.infer<typeof createGrantSchema>;
export type UpdateGrantDto = z.infer<typeof updateGrantSchema>;

const scopeIdFields = {
  scopeDivisionId: z.string().uuid().nullish(),
  scopeTeamId: z.string().uuid().nullish(),
  scopeRoleId: z.string().uuid().nullish(),
};

/**
 * `POST /grants/batch` — the matrix editor's staged changes, applied all-or-nothing.
 * `update`/`retire` carry the `version` the editor last saw, so a grant someone else
 * changed in the meantime refuses the whole batch (409) instead of being overwritten.
 * An update re-scopes a grant; its action and role are fixed (retire + create to move).
 */
export const batchGrantChangeSchema = z.discriminatedUnion('op', [
  createGrantSchema.extend({ op: z.literal('create') }),
  z
    .object({
      op: z.literal('update'),
      id: z.string().uuid(),
      version: z.number().int(),
      effect: z.enum(['permit', 'forbid']).optional(),
      scopeKind: scopeKindSchema,
      ...scopeIdFields,
    })
    .strict(),
  z.object({ op: z.literal('retire'), id: z.string().uuid(), version: z.number().int() }).strict(),
]);

export const batchGrantsSchema = z
  .object({ changes: z.array(batchGrantChangeSchema).min(1).max(500) })
  .strict();

export type BatchGrantChange = z.infer<typeof batchGrantChangeSchema>;
export type BatchGrantsDto = z.infer<typeof batchGrantsSchema>;
