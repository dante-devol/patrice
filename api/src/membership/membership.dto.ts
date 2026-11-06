import { z } from 'zod';

export const addMemberSchema = z.object({ userId: z.string().uuid() }).strict();
export type AddMemberDto = z.infer<typeof addMemberSchema>;

const unitType = z.enum(['division', 'team']);

/**
 * `POST /memberships/batch`: the membership editor's staged changes, applied
 * all-or-nothing. Each change states what the editor saw: an `add` expects the person
 * not to be a member yet and a `remove` expects them to be one, so a change someone else
 * made in the meantime refuses the whole batch (409 STALE_MEMBERSHIP).
 */
export const membershipChangeSchema = z
  .object({
    op: z.enum(['add', 'remove']),
    unitType,
    unitId: z.string().uuid(),
    userId: z.string().uuid(),
  })
  .strict();

export const batchMembershipsSchema = z
  .object({ changes: z.array(membershipChangeSchema).min(1).max(500) })
  .strict();

export type MembershipChange = z.infer<typeof membershipChangeSchema>;
export type BatchMembershipsDto = z.infer<typeof batchMembershipsSchema>;
