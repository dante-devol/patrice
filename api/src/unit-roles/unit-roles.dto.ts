import { z } from 'zod';

export const assignUnitRoleSchema = z.object({ userId: z.string().uuid(), roleId: z.string().uuid() }).strict();
export type AssignUnitRoleDto = z.infer<typeof assignUnitRoleSchema>;
