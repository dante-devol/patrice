import { z } from 'zod';

/**
 * Team DTOs. A team supports a set of divisions: `allDivisions: true` (every division,
 * including ones created later), or `divisionIds` (at least one). Give exactly one.
 * PATCH may change the set; `.strict()` rejects anything else.
 */
const name = z.string().trim().min(1, 'Team name is required').max(120);
const divisionIds = z.array(z.string().uuid()).min(1, 'Choose at least one division').max(200);

const oneDivisionChoice = <T extends { divisionIds?: string[]; allDivisions?: boolean }>(t: T) =>
  !(t.allDivisions === true && t.divisionIds !== undefined);
const choiceMessage = { message: 'Give divisionIds or allDivisions: true, not both', path: ['divisionIds'] };

export const createTeamSchema = z
  .object({
    divisionIds: divisionIds.optional(),
    allDivisions: z.boolean().optional(),
    name,
    restrictClaims: z.boolean().optional(),
    // The unit role people get when they join (ADR 0022). Omitted on create: the org's default.
    defaultRoleId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(oneDivisionChoice, choiceMessage)
  .refine((t) => t.allDivisions === true || t.divisionIds !== undefined, {
    message: 'Choose at least one division, or all divisions',
    path: ['divisionIds'],
  });

export const updateTeamSchema = z
  .object({
    name: name.optional(),
    restrictClaims: z.boolean().optional(),
    // The unit role people get when they join (ADR 0022). Omitted on create: the org's default.
    defaultRoleId: z.string().uuid().nullable().optional(),
    /** Replaces the team's division list (and turns off allDivisions). */
    divisionIds: divisionIds.optional(),
    /** True: support every division. False needs divisionIds alongside it. */
    allDivisions: z.boolean().optional(),
    // Optional optimistic-lock check: the version the client last read.
    version: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(oneDivisionChoice, choiceMessage)
  .refine((t) => t.allDivisions !== false || t.divisionIds !== undefined, {
    message: 'Turning off all divisions needs the divisions to keep',
    path: ['divisionIds'],
  });

export type CreateTeamDto = z.infer<typeof createTeamSchema>;
export type UpdateTeamDto = z.infer<typeof updateTeamSchema>;
