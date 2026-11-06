import { z } from 'zod';

/**
 * Role DTOs. PATCH accepts the name and (unit roles) `assignableByLeads`;
 * `.strict()` makes any other field a 422 rather than a silent ignore. The kind is
 * fixed at creation. Lifecycle (retire/revive) goes through the named action endpoints.
 */
const name = z.string().trim().min(1, 'Role name is required').max(120);

/** `kind` is fixed at creation: an `org` role (default) or a `unit` role. */
export const createRoleSchema = z
  .object({
    name,
    kind: z.enum(['org', 'unit']).optional(),
    assignableByLeads: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.kind === 'unit' || r.assignableByLeads === undefined, {
    message: 'Only a unit role can be assignable by leads',
  });

export const updateRoleSchema = z
  .object({
    name: name.optional(),
    assignableByLeads: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.name !== undefined || r.assignableByLeads !== undefined, { message: 'Nothing to change' });

export type CreateRoleDto = z.infer<typeof createRoleSchema>;
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
