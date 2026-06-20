import { z } from 'zod';

/**
 * Team DTOs. PATCH accepts `name` and `restrict_claims` only (Slice 2 PATCH
 * convention); `.strict()` rejects anything else with 422.
 */
const name = z.string().trim().min(1, 'Team name is required').max(120);

export const createTeamSchema = z
  .object({
    name,
    restrictClaims: z.boolean().optional(),
  })
  .strict();

export const updateTeamSchema = z
  .object({
    name: name.optional(),
    restrictClaims: z.boolean().optional(),
  })
  .strict();

export type CreateTeamDto = z.infer<typeof createTeamSchema>;
export type UpdateTeamDto = z.infer<typeof updateTeamSchema>;
