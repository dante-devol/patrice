import { z } from 'zod';

/**
 * Team DTOs. A team belongs to one division, chosen at creation and fixed after.
 * PATCH accepts `name` and `restrictClaims` only; `.strict()` rejects anything else.
 */
const name = z.string().trim().min(1, 'Team name is required').max(120);

export const createTeamSchema = z
  .object({
    divisionId: z.string().uuid(),
    name,
    restrictClaims: z.boolean().optional(),
  })
  .strict();

export const updateTeamSchema = z
  .object({
    name: name.optional(),
    restrictClaims: z.boolean().optional(),
    // Optional optimistic-lock check: the version the client last read.
    version: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CreateTeamDto = z.infer<typeof createTeamSchema>;
export type UpdateTeamDto = z.infer<typeof updateTeamSchema>;
