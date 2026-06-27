import { z } from 'zod';

export const connectIntegrationSchema = z.object({
  provider: z.enum(['discord']),
  externalWorkspaceId: z.string().min(1),
  displayName: z.string().min(1).max(200),
  config: z.record(z.unknown()).default({}),
  credentialsRef: z.string().optional(),
});

export const updateIntegrationSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.unknown()).optional(),
  credentialsRef: z.string().optional(),
});

export const createMappingSchema = z.object({
  roleId: z.string().uuid(),
  externalGroupId: z.string().min(1),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
});

export const updateMappingSchema = z.object({
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
  conflictWinner: z.enum(['patrice', 'external']).optional(),
  // Re-point a mapping at a different Discord role (e.g. after the group was
  // recreated). Clears the broken flag so the next sync re-evaluates it.
  externalGroupId: z.string().min(1).optional(),
});

export const rotateTokenSchema = z.object({
  botToken: z.string().min(1),
});

export type ConnectIntegrationDto = z.infer<typeof connectIntegrationSchema>;
export type UpdateIntegrationDto = z.infer<typeof updateIntegrationSchema>;
export type CreateMappingDto = z.infer<typeof createMappingSchema>;
export type UpdateMappingDto = z.infer<typeof updateMappingSchema>;
export type RotateTokenDto = z.infer<typeof rotateTokenSchema>;
