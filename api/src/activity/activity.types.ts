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

  // Slice 2 — org configuration. IDs-only (no names/PII; render by joining at read).
  'role.created': z.object({ roleId: uuid }).strict(),
  'role.updated': z.object({ roleId: uuid }).strict(),
  'role.retired': z.object({ roleId: uuid }).strict(),
  'role.revived': z.object({ roleId: uuid }).strict(),
  'division.created': z.object({ divisionId: uuid }).strict(),
  'division.updated': z.object({ divisionId: uuid }).strict(),
  'division.retired': z.object({ divisionId: uuid }).strict(),
  'division.revived': z.object({ divisionId: uuid }).strict(),
  'team.created': z.object({ teamId: uuid }).strict(),
  'team.updated': z.object({ teamId: uuid }).strict(),
  'team.retired': z.object({ teamId: uuid }).strict(),
  'team.revived': z.object({ teamId: uuid }).strict(),
  'grant.created': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'grant.updated': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'grant.retired': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'grant.revived': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'user_role.granted': z.object({ userId: uuid, roleId: uuid }).strict(),
  'user_role.revoked': z.object({ userId: uuid, roleId: uuid }).strict(),
  'user.updated': z.object({ userId: uuid }).strict(),
  'user.deactivated': z.object({ userId: uuid }).strict(),
  'user.reactivated': z.object({ userId: uuid }).strict(),
  'config.updated': z
    .object({ changedKeys: z.array(z.string()) })
    .strict(),
  // The LAST_ADMIN guard rejections — a useful security signal. `subjectType`/
  // `subjectId` name the attempted target; the payload stays IDs-only.
  'last_admin_refused': z
    .object({ path: z.string(), subjectId: uuid })
    .strict(),
} as const;

export type ActivityVerb = keyof typeof activityPayloadSchemas;

export type ActivityPayload<V extends ActivityVerb> = z.infer<
  (typeof activityPayloadSchemas)[V]
>;
