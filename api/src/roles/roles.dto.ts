import { z } from 'zod';

/**
 * Role DTOs. The PATCH endpoint accepts **only pure metadata** (`name`) per the
 * Slice 2 PATCH convention — `.strict()` makes any other field a 422 rather than a
 * silent ignore. Lifecycle (retire/revive) goes through the named action endpoints.
 */
export const createRoleSchema = z
  .object({
    name: z.string().trim().min(1, 'Role name is required').max(120),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1, 'Role name is required').max(120),
  })
  .strict();

export type CreateRoleDto = z.infer<typeof createRoleSchema>;
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
