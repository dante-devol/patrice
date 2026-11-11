import { z } from 'zod';

/**
 * Division DTOs. PATCH accepts the documented editable fields only
 * (`name`, `default_openings`, `openings_locked`, `restrict_claims`); `.strict()`
 * turns anything else into a 422. Lifecycle goes through retire/revive endpoints.
 */
const name = z.string().trim().min(1, 'Division name is required').max(120);
const defaultOpenings = z.number().int().min(1).max(10_000);

export const createDivisionSchema = z
  .object({
    name,
    defaultOpenings: defaultOpenings.optional(),
    openingsLocked: z.boolean().optional(),
    restrictClaims: z.boolean().optional(),
    allowCustomTemplates: z.boolean().optional(),
    // The unit role people get when they join (ADR 0022). Omitted: the org's default.
    defaultRoleId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateDivisionSchema = z
  .object({
    name: name.optional(),
    defaultOpenings: defaultOpenings.optional(),
    openingsLocked: z.boolean().optional(),
    restrictClaims: z.boolean().optional(),
    allowCustomTemplates: z.boolean().optional(),
    defaultRoleId: z.string().uuid().nullable().optional(),
    // Optional optimistic-lock check: the version the client last read.
    version: z.number().int().nonnegative().optional(),
  })
  .strict();

export type CreateDivisionDto = z.infer<typeof createDivisionSchema>;
export type UpdateDivisionDto = z.infer<typeof updateDivisionSchema>;
