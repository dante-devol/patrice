import { z } from 'zod';

/** PATCH /users/:id — pure metadata only (Slice 2 PATCH convention). */
export const updateUserSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Display name is required').max(200),
  })
  .strict();

/** POST /users/:id/roles — grant a role (scoped by the granted role). */
export const grantRoleSchema = z
  .object({
    roleId: z.string().uuid(),
  })
  .strict();

/**
 * PATCH /config — structured `organization.settings` editor. All flags optional;
 * `.strict()` rejects unknown keys. Defaults live in ConfigService.
 */
export const updateConfigSchema = z
  .object({
    requireVerifiedEmailToLogIn: z.boolean().optional(),
    selfReviewAllowed: z.boolean().optional(),
    anonymizeLabel: z.boolean().optional(),
    sessionAbsoluteDays: z.number().int().positive().max(3650).optional(),
    sessionIdleDays: z.number().int().positive().max(3650).optional(),
    // Retire→revive grace window in hours (Slice 7.2). 0 disables the window
    // (revive only same-instant; GC collects as soon as references clear).
    gracePeriodHours: z.number().int().nonnegative().max(8760).optional(),
    // Slice 8: gate task access on Discord account linking.
    requireDiscordLink: z.boolean().optional(),
  })
  .strict();

export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type GrantRoleDto = z.infer<typeof grantRoleSchema>;
export type UpdateConfigDto = z.infer<typeof updateConfigSchema>;
