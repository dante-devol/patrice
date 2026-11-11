import { z } from 'zod';

/** PATCH /users/:id — pure metadata only (the PATCH convention). */
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
 * PATCH /config — typed `system_settings` editor. All flags optional;
 * `.strict()` rejects unknown keys. Defaults live in ConfigService.
 */
/** The settings columns an admin edits (everything but the write-only secret). */
const settingsFields = {
  requireVerifiedEmailToLogIn: z.boolean().optional(),
  selfReviewAllowed: z.boolean().optional(),
  anonymizeLabel: z.boolean().optional(),
  sessionAbsoluteDays: z.number().int().positive().max(3650).optional(),
  sessionIdleDays: z.number().int().positive().max(3650).optional(),
  gracePeriodHours: z.number().int().nonnegative().max(8760).optional(),
  requireDiscordLink: z.boolean().optional(),
  discordClientId: z.string().max(64).nullable().optional(),
  defaultUnitRoleId: z.string().uuid().nullable().optional(),
};

export const updateConfigSchema = z
  .object({
    requireVerifiedEmailToLogIn: z.boolean().optional(),
    selfReviewAllowed: z.boolean().optional(),
    anonymizeLabel: z.boolean().optional(),
    sessionAbsoluteDays: z.number().int().positive().max(3650).optional(),
    sessionIdleDays: z.number().int().positive().max(3650).optional(),
    // Retire→revive grace window in hours. 0 disables the window
    // (revive only same-instant; GC collects as soon as references clear).
    gracePeriodHours: z.number().int().nonnegative().max(8760).optional(),
    // gate task access on Discord account linking.
    requireDiscordLink: z.boolean().optional(),
    // Discord sign-in OAuth app (ADR 0006). The id is public; the secret is
    // write-only (encrypted at rest, never returned). Empty string clears it.
    discordClientId: z.string().max(64).optional(),
    discordClientSecret: z.string().max(256).optional(),
    // The unit role new divisions and teams start with as their default (ADR 0022).
    defaultUnitRoleId: z.string().uuid().nullable().optional(),
    // Optional stale check: the values the editor last read for the fields it changes.
    // Settings share one row whose `updated_at` moves with every permission change, so
    // the check is per field rather than by version.
    expected: z.object(settingsFields).strict().optional(),
  })
  .strict();

export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type GrantRoleDto = z.infer<typeof grantRoleSchema>;
export type UpdateConfigDto = z.infer<typeof updateConfigSchema>;
