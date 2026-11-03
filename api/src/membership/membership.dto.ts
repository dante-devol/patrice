import { z } from 'zod';

export const addMemberSchema = z.object({ userId: z.string().uuid() }).strict();
export type AddMemberDto = z.infer<typeof addMemberSchema>;
