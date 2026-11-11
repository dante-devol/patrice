import { z } from 'zod';

/**
 * Activity verb catalog + per-verb payload schemas.
 *
 * Activity Payload Discipline (api/CONTEXT.md): `activity.payload` carries **IDs
 * only — never PII strings** (no email, no displayName). Every schema below is
 * `.strict()`, so a stray `email`/`displayName` key is rejected at the write, not
 * just discouraged. PII is rendered by joining to current state at read time.
 *
 * Every verb the system audits is registered here.
 */
const uuid = z.string().uuid();

/**
 * Before → after values for changed configuration fields (§6.5): names, flags and
 * numbers, never personal data or user-authored text. Absent on older rows.
 */
const changes = z
  .record(z.object({ from: z.unknown(), to: z.unknown() }).strict())
  .optional();

/** What a group mapping grants. */
const mappingTarget = { targetKind: z.enum(['role', 'division', 'team']), targetId: uuid };

/** Which questions an edit added, removed and kept (ids only). */
const questionDiff = z
  .object({ added: z.array(uuid), removed: z.array(uuid), changed: z.array(uuid) })
  .strict();

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
      identityProvider: z.enum(['password', 'google', 'discord']),
    })
    .strict(),

  // org configuration. IDs-only (no names/PII; render by joining at read).
  'role.created': z.object({ roleId: uuid }).strict(),
  'role.updated': z.object({ roleId: uuid, changes }).strict(),
  'role.retired': z.object({ roleId: uuid }).strict(),
  'role.revived': z.object({ roleId: uuid }).strict(),
  'division.created': z.object({ divisionId: uuid }).strict(),
  'division.updated': z.object({ divisionId: uuid, changes }).strict(),
  'division.retired': z.object({ divisionId: uuid }).strict(),
  'division.revived': z.object({ divisionId: uuid }).strict(),
  'team.created': z.object({ teamId: uuid }).strict(),
  'membership.added': z.object({ userId: uuid, unitType: z.enum(['division', 'team']), unitId: uuid }).strict(),
  'membership.removed': z.object({ userId: uuid, unitType: z.enum(['division', 'team']), unitId: uuid }).strict(),
  // `viaDefault`: given or removed because the person joined or left the unit (ADR 0022).
  'unit_role.assigned': z
    .object({
      userId: uuid,
      roleId: uuid,
      unitType: z.enum(['division', 'team']),
      unitId: uuid,
      viaDefault: z.boolean().optional(),
    })
    .strict(),
  'unit_role.unassigned': z
    .object({
      userId: uuid,
      roleId: uuid,
      unitType: z.enum(['division', 'team']),
      unitId: uuid,
      viaDefault: z.boolean().optional(),
    })
    .strict(),
  'team.updated': z.object({ teamId: uuid, changes }).strict(),
  'team.retired': z.object({ teamId: uuid }).strict(),
  'team.revived': z.object({ teamId: uuid }).strict(),
  'grant.created': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'grant.updated': z
    .object({
      grantId: uuid,
      roleId: uuid,
      // Configuration: recorded as values (before → after), not just ids.
      before: z.object({ action: z.string(), effect: z.string(), scopeKind: z.string(), scopeId: uuid.nullable() }).strict().optional(),
      after: z.object({ action: z.string(), effect: z.string(), scopeKind: z.string(), scopeId: uuid.nullable() }).strict().optional(),
    })
    .strict(),
  'grant.retired': z.object({ grantId: uuid, roleId: uuid }).strict(),
  'grant.revived': z.object({ grantId: uuid, roleId: uuid }).strict(),
  // Phase 3: grants, messages and attachments are hard-deleted; the audit row records
  // the grant's shape (configuration) so "what was removed" stays answerable.
  'grant.deleted': z
    .object({
      grantId: uuid,
      roleId: uuid,
      action: z.string(),
      effect: z.enum(['permit', 'forbid']),
      scopeKind: z.string(),
      scopeId: uuid.nullable(),
    })
    .strict(),
  'user_role.granted': z.object({ userId: uuid, roleId: uuid }).strict(),
  'user_role.revoked': z.object({ userId: uuid, roleId: uuid }).strict(),
  'user.updated': z.object({ userId: uuid }).strict(),
  'user.deactivated': z.object({ userId: uuid }).strict(),
  'user.reactivated': z.object({ userId: uuid }).strict(),
  // user retirement lifecycle. IDs only.
  'user.retired': z.object({ userId: uuid }).strict(),
  'user.revived': z.object({ userId: uuid }).strict(),
  'config.updated': z
    .object({ changedKeys: z.array(z.string()), changes })
    .strict(),
  // Request templates. Name, default flag, and question count and types are
  // configuration and recorded as values; prompts and options are user-authored text,
  // recorded by question id only.
  'request_template.created': z
    .object({
      requestTemplateId: uuid,
      divisionId: uuid,
      name: z.string(),
      isDefault: z.boolean(),
      questionCount: z.number().int(),
      questionTypes: z.array(z.string()),
    })
    .strict(),
  'request_template.updated': z
    .object({
      requestTemplateId: uuid,
      divisionId: uuid,
      changes,
      descriptionChanged: z.boolean(),
      questionCount: z.number().int(),
      questionTypes: z.array(z.string()),
      questions: questionDiff.optional(),
    })
    .strict(),
  'request_template.deleted': z
    .object({
      requestTemplateId: uuid,
      divisionId: uuid,
      name: z.string(),
      isDefault: z.boolean(),
      questionCount: z.number().int(),
    })
    .strict(),
  // A task's own questions edited (task:configure_request_template).
  'task_request_template.updated': z
    .object({
      taskId: uuid,
      questionCount: z.number().int(),
      questionTypes: z.array(z.string()),
      questions: questionDiff,
    })
    .strict(),
  // Tasks. IDs only (no name/description PII; render by joining at read).
  'task.created': z
    .object({
      taskId: uuid,
      divisionId: uuid,
      teamId: uuid.nullable(),
      templateOrigin: z.enum(['library', 'custom']),
      sourceTemplateId: uuid.nullable(),
      questionCount: z.number().int(),
    })
    .strict(),
  'task.updated': z.object({ taskId: uuid }).strict(),
  'task.retired': z.object({ taskId: uuid }).strict(),
  'task.revived': z.object({ taskId: uuid }).strict(),
  // claiming / openings / requester. IDs + the new status only.
  'task.claimed': z
    .object({ taskId: uuid, userId: uuid, statusCache: z.string() })
    .strict(),
  'task.left': z
    .object({ taskId: uuid, userId: uuid, statusCache: z.string() })
    .strict(),
  'task.claims_updated': z
    .object({ taskId: uuid, openings: z.number().int(), claimsClosed: z.boolean(), statusCache: z.string() })
    .strict(),
  'task.requester_changed': z
    .object({ taskId: uuid, requesterUserId: uuid })
    .strict(),
  // messages + attachments. IDs only.
  'message.created': z
    .object({ messageId: uuid, taskId: uuid, parentMessageId: uuid.nullable() })
    .strict(),
  'message.updated': z.object({ messageId: uuid, taskId: uuid }).strict(),
  'message.retired': z.object({ messageId: uuid, taskId: uuid }).strict(),
  'message.revived': z.object({ messageId: uuid, taskId: uuid }).strict(),
  'message.deleted': z.object({ messageId: uuid, taskId: uuid, keptAsMarker: z.boolean() }).strict(),
  // An upload, onto a message or pending (for an answer).
  'attachment.created': z
    .object({ attachmentId: uuid, taskId: uuid, messageId: uuid.nullable() })
    .strict(),
  // attachment lifecycle (independent retire/revive of a single file).
  'attachment.retired': z.object({ attachmentId: uuid }).strict(),
  'attachment.revived': z.object({ attachmentId: uuid }).strict(),
  'attachment.deleted': z.object({ attachmentId: uuid, taskId: uuid }).strict(),
  // submission lifecycle. IDs + the (non-PII) submission_no/decision/status.
  'submission.submitted': z
    .object({
      taskId: uuid,
      submissionId: uuid,
      claimantUserId: uuid,
      submissionNo: z.number().int(),
    })
    .strict(),
  'submission.reviewed': z
    .object({
      taskId: uuid,
      submissionId: uuid,
      decision: z.enum(['approve', 'return', 'reject']),
      statusCache: z.string(),
    })
    .strict(),
  // `reason` is moderation content (not PII) and is the audit's whole point; kept.
  'submission.retired': z
    .object({
      taskId: uuid,
      submissionId: uuid,
      claimantUserId: uuid,
      // The timeline entry that holds the reason; free text stays out of the audit log.
      eventId: uuid,
    })
    .strict(),
  'task.claimant_removed': z
    .object({ taskId: uuid, removedUserId: uuid, statusCache: z.string(), submissionsRejected: z.array(uuid) })
    .strict(),
  'task.completed': z
    .object({ taskId: uuid, statusCache: z.string(), submissionsNotRequired: z.number().int() })
    .strict(),
  // GC sweep. System-actored (actor_user_id NULL), IDs-only. One row per
  // collected aggregate/entity; `gc.blocked` records a RESTRICT backstop hit (a live
  // reference left the row in place); `gc.blob_reconciled` records orphaned-blob cleanup.
  'gc.task_collected': z.object({ taskId: uuid }).strict(),
  'gc.role_collected': z.object({ roleId: uuid }).strict(),
  'gc.division_collected': z.object({ divisionId: uuid }).strict(),
  'gc.team_collected': z.object({ teamId: uuid }).strict(),
  'gc.blocked': z.object({ entityType: z.string(), entityId: uuid }).strict(),
  'gc.blob_reconciled': z.object({ blobCount: z.number().int() }).strict(),
  // user GC. Scrub keeps the row (tombstone); collect deletes a
  // history-less user outright. The auto-revoke of invitations issued by a scrubbed
  // user is system-actored (actor_user_id NULL), one row per invite.
  'gc.user_scrubbed': z.object({ userId: uuid }).strict(),
  'gc.user_collected': z.object({ userId: uuid }).strict(),
  'invite.auto_revoked_on_issuer_retired': z
    .object({ invitationId: uuid, issuerUserId: uuid })
    .strict(),
  // The LAST_ADMIN guard rejections — a useful security signal. `subjectType`/
  // `subjectId` name the attempted target; the payload stays IDs-only.
  'last_admin_refused': z
    .object({ path: z.string(), subjectId: uuid })
    .strict(),
  // integration lifecycle.
  'integration.connected': z.object({ connectionId: uuid }).strict(),
  'integration.updated': z.object({ connectionId: uuid }).strict(),
  // `grants` is applied to what the connection granted when it's collected.
  'integration.retired': z.object({ connectionId: uuid, grants: z.enum(['keep', 'revoke']).optional() }).strict(),
  'integration.grants_released': z
    .object({ connectionId: uuid, grants: z.enum(['keep', 'revoke']), affected: z.number().int() })
    .strict(),
  'integration.revived': z.object({ connectionId: uuid }).strict(),
  'integration.token_rotated': z.object({ connectionId: uuid }).strict(),
  'integration.synced': z
    .object({ connectionId: uuid, grantedCount: z.number().int(), revokedCount: z.number().int() })
    .strict(),
  'integration.broken': z.object({ connectionId: uuid, externalGroupId: z.string() }).strict(),
  // Outbound push to Discord was refused (reason is a code; the UI humanizes it).
  'integration.push_failed': z
    .object({
      connectionId: uuid,
      roleId: uuid.nullable(),
      externalGroupId: z.string(),
      reason: z.enum(['permission', 'not_found', 'other']),
    })
    .strict(),
  // Gateway socket + reconcile lifecycle (admin visibility — no log-reading needed).
  'integration.gateway_connected': z.object({ connectionId: uuid }).strict(),
  'integration.gateway_disconnected': z.object({ connectionId: uuid }).strict(),
  'integration.gateway_degraded': z.object({ connectionId: uuid }).strict(),
  // reason: why a reconcile was scheduled (doorbell | floor | manual | link | role_change).
  'integration.reconcile_scheduled': z
    .object({ connectionId: uuid, reason: z.string() })
    .strict(),
  'integration.sync_started': z.object({ connectionId: uuid }).strict(),
  'integration.token_invalid': z.object({ connectionId: uuid }).strict(),
  // A broken mapping was cleared by an admin to retry it.
  'integration.mapping_retried': z
    .object({ mappingId: uuid, connectionId: uuid, ...mappingTarget })
    .strict(),
  'integration.removed': z
    .object({ connectionId: uuid, userId: uuid, roleId: uuid })
    .strict(),
  // Outbound (Patrice → Discord) per-user role pushes — one row per (user, role).
  'integration.external_role_added': z
    .object({ connectionId: uuid, userId: uuid, ...mappingTarget, externalGroupId: z.string() })
    .strict(),
  'integration.external_role_removed': z
    .object({ connectionId: uuid, userId: uuid, ...mappingTarget, externalGroupId: z.string() })
    .strict(),
  'external_identity.linked': z
    .object({ connectionId: uuid, userId: uuid, externalIdentityId: uuid })
    .strict(),
  'external_identity.unlinked': z
    .object({ connectionId: uuid, userId: uuid, externalIdentityId: uuid })
    .strict(),
  // The Discord *sign-in method* (user_identity[discord]) was added/removed — an
  // auth-security event, distinct from the per-connection integration link above.
  'auth.discord_linked': z.object({ userId: uuid }).strict(),
  'auth.discord_unlinked': z.object({ userId: uuid }).strict(),
  // Phase 1 account self-service. `provider` is a sign-in method, not personal data.
  'auth.identity_linked': z.object({ userId: uuid, provider: z.enum(['password', 'google', 'discord']) }).strict(),
  'auth.identity_unlinked': z.object({ userId: uuid, provider: z.enum(['password', 'google', 'discord']) }).strict(),
  'auth.password_changed': z.object({ userId: uuid }).strict(),
  'auth.email_changed': z.object({ userId: uuid }).strict(),
  'session.revoked': z.object({ sessionId: uuid, userId: uuid }).strict(),
  'external_group_mapping.created': z
    .object({ mappingId: uuid, connectionId: uuid, ...mappingTarget })
    .strict(),
  'external_group_mapping.updated': z
    .object({ mappingId: uuid, connectionId: uuid, ...mappingTarget })
    .strict(),
  // Deleted outright; `grants` says what happened to the roles/memberships it made.
  'external_group_mapping.deleted': z
    .object({
      mappingId: uuid,
      connectionId: uuid,
      ...mappingTarget,
      grants: z.enum(['keep', 'revoke']),
      affected: z.number().int(),
    })
    .strict(),
  'gc.integration_connection_collected': z.object({ connectionId: uuid }).strict(),
} as const;

export type ActivityVerb = keyof typeof activityPayloadSchemas;

export type ActivityPayload<V extends ActivityVerb> = z.infer<
  (typeof activityPayloadSchemas)[V]
>;
