import { z } from 'zod';

/**
 * Activity verb catalog + per-verb payload schemas.
 *
 * Activity Payload Discipline (api/CONTEXT.md): `activity.payload` carries **IDs
 * only — never PII strings** (no email, no displayName). Every schema below is
 * `.strict()`, so a stray `email`/`displayName` key is rejected at the write, not
 * just discouraged. PII is rendered by joining to current state at read time.
 *
 * Slice 1 registers: invite.created, invite.redeemed, invite.revoked,
 * bootstrap.completed, user.registered. Each later slice extends this catalog.
 */
const uuid = z.string().uuid();

export const activityPayloadSchemas = {
  'invite.created': z
    .object({
      invitationId: uuid,
      intendedRoleIds: z.array(uuid),
      isBootstrap: z.boolean(),
    })
    .strict(),
  'invite.redeemed': z
    .object({
      invitationId: uuid,
      createdUserId: uuid,
      grantedRoleIds: z.array(uuid),
    })
    .strict(),
  'invite.revoked': z
    .object({
      invitationId: uuid,
    })
    .strict(),
  'bootstrap.completed': z
    .object({
      adminUserId: uuid,
      invitationId: uuid,
    })
    .strict(),
  'user.registered': z
    .object({
      userId: uuid,
      invitationId: uuid,
      identityProvider: z.enum(['password', 'google']),
    })
    .strict(),
} as const;

export type ActivityVerb = keyof typeof activityPayloadSchemas;

export type ActivityPayload<V extends ActivityVerb> = z.infer<
  (typeof activityPayloadSchemas)[V]
>;
