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
