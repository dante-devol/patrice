import { z } from 'zod';

const botToken = z.string().trim().min(1).max(200);
const grants = z.enum(['keep', 'revoke']);

/**
 * Connect a server. The bot token goes straight to the worker, which encrypts it;
 * it is never stored or returned by the API.
 */
export const connectIntegrationSchema = z
  .object({
    provider: z.enum(['discord']),
    externalWorkspaceId: z.string().min(1),
    displayName: z.string().min(1).max(200),
    botToken: botToken.optional(),
  })
  .strict();

export const updateIntegrationSchema = z
  .object({ displayName: z.string().min(1).max(200).optional() })
  .strict();

/** Retire a connection; `grants` decides, at collection, what happens to what it granted. */
export const retireIntegrationSchema = z.object({ grants: grants.optional() }).strict().default({});

/** A mapping targets exactly one of a role, a division or a team. */
export const createMappingSchema = z
  .object({
    roleId: z.string().uuid().optional(),
    divisionId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    externalGroupId: z.string().min(1),
    syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
  })
  .strict()
  .refine((m) => [m.roleId, m.divisionId, m.teamId].filter(Boolean).length === 1, {
    message: 'Give exactly one of roleId, divisionId or teamId',
  });

export const updateMappingSchema = z
  .object({
    syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
    conflictWinner: z.enum(['patrice', 'external']).optional(),
    // Re-point a mapping at a different Discord role (e.g. after the group was
    // recreated). Clears the broken flag so the next sync re-evaluates it.
    externalGroupId: z.string().min(1).optional(),
  })
  .strict();

/** Delete a mapping; `grants` decides what happens to what it granted (default keep). */
export const deleteMappingSchema = z.object({ grants: grants.optional() }).strict();

export const rotateTokenSchema = z.object({ botToken }).strict();

export type ConnectIntegrationDto = z.infer<typeof connectIntegrationSchema>;
export type UpdateIntegrationDto = z.infer<typeof updateIntegrationSchema>;
export type RetireIntegrationDto = z.infer<typeof retireIntegrationSchema>;
export type CreateMappingDto = z.infer<typeof createMappingSchema>;
export type UpdateMappingDto = z.infer<typeof updateMappingSchema>;
export type DeleteMappingDto = z.infer<typeof deleteMappingSchema>;
export type RotateTokenDto = z.infer<typeof rotateTokenSchema>;
