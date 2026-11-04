import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ERROR_CODES, ErrorCode } from '../common/error-codes';
import { TIMELINE_EVENT_TYPES, domainEventPayloadSchemas } from '../events/event.types';

// Adds `.openapi()` to every Zod schema. Must run before any schema below is built.
extendZodWithOpenApi(z);

/**
 * Response schemas: the API's side of the contract. Each mirrors a view the services
 * return, as it looks on the wire (dates are ISO strings). In tests the contract
 * check validates every JSON response against these, so they can't silently drift.
 */

const id = z.string().uuid();
const timestamp = z.string().datetime();
const nullableTimestamp = timestamp.nullable();

export const Lifecycle = z.enum(['active', 'deactivated', 'retired']).openapi('Lifecycle');
export const ScopeKind = z
  .enum(['global', 'own', 'own_division', 'own_team', 'specific_division', 'specific_team', 'role'])
  .openapi('ScopeKind');
export const QuestionType = z
  .enum(['detail_text', 'multiline', 'text', 'numeric', 'dropdown', 'radio', 'attachment'])
  .openapi('QuestionType');
export const TaskStatus = z.enum(['open', 'claimed', 'review', 'revising', 'approved']).openapi('TaskStatus');
export const SubmissionState = z
  .enum(['review', 'revising', 'approved', 'rejected', 'not_required'])
  .openapi('SubmissionState');
export const TemplateOrigin = z.enum(['library', 'custom']).openapi('TemplateOrigin');
export const AuthMethod = z.enum(['password', 'google', 'discord']).openapi('AuthMethod');
export const InvitationStatus = z.enum(['pending', 'revoked', 'exhausted', 'expired']).openapi('InvitationStatus');
export const ActivitySource = z.enum(['patrice', 'integration', 'system']).openapi('ActivitySource');
export const IntegrationProvider = z.enum(['discord']).openapi('IntegrationProvider');
export const IntegrationStatus = z.enum(['active', 'broken', 'disabled']).openapi('IntegrationStatus');
export const SyncDirection = z.enum(['inbound', 'outbound', 'bidirectional']).openapi('SyncDirection');
export const ConflictWinner = z.enum(['patrice', 'external']).openapi('ConflictWinner');
export const GatewayState = z.enum(['down', 'connecting', 'connected', 'degraded']).openapi('GatewayState');
export const SyncState = z.enum(['idle', 'queued', 'running']).openapi('SyncState');

export const ErrorCodeSchema = z
  .enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]])
  .openapi('ErrorCode', { description: 'Every error code the API returns; see the catalog for statuses.' });

export const ErrorBody = z
  .object({
    error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }),
  })
  .openapi('ErrorBody');

export const Ok = z.object({ ok: z.literal(true) }).strict().openapi('Ok');

// ---- Identity ---------------------------------------------------------------

export const CurrentUser = z
  .object({
    id,
    email: z.string().nullable(),
    displayName: z.string(),
    emailVerified: z.boolean(),
    authMethods: z.array(AuthMethod),
    hasDiscordLink: z.boolean(),
    discordHandle: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    allowedActions: z.array(z.string()),
    taskAccessBlockedByDiscord: z.boolean(),
  })
  .strict()
  .openapi('CurrentUser');

export const Session = z
  .object({
    id,
    authMethod: AuthMethod,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    current: z.boolean(),
  })
  .strict()
  .openapi('Session');

export const BootstrapStatus = z
  .object({ open: z.boolean(), inviteToken: z.string().nullable() })
  .strict()
  .openapi('BootstrapStatus');

export const InviteView = z
  .object({
    requiresEmail: z.boolean(),
    requiresPasscode: z.boolean(),
    status: InvitationStatus,
    isBootstrap: z.boolean(),
  })
  .strict()
  .openapi('InviteView');

export const InvitationListItem = z
  .object({
    id,
    email: z.string().nullable(),
    intendedRoleIds: z.array(id),
    maxUses: z.number().int(),
    useCount: z.number().int(),
    status: InvitationStatus,
    createdAt: timestamp,
    expiresAt: timestamp,
  })
  .strict()
  .openapi('InvitationListItem');

export const CreatedInvitation = z
  .object({ id, token: z.string(), url: z.string() })
  .strict()
  .openapi('CreatedInvitation');

export const AdminUser = z
  .object({
    id,
    email: z.string().nullable(),
    displayName: z.string(),
    lifecycleState: Lifecycle,
    roleIds: z.array(id),
    avatarUrl: z.string().nullable(),
  })
  .strict()
  .openapi('AdminUser');

export const OrgSettings = z
  .object({
    requireVerifiedEmailToLogIn: z.boolean(),
    selfReviewAllowed: z.boolean(),
    anonymizeLabel: z.boolean(),
    sessionAbsoluteDays: z.number().int(),
    sessionIdleDays: z.number().int(),
    gracePeriodHours: z.number().int(),
    requireDiscordLink: z.boolean(),
    discordClientId: z.string().nullable(),
    discordOAuthConfigured: z.boolean(),
  })
  .strict()
  .openapi('OrgSettings');

// ---- Access ------------------------------------------------------------------

export const Role = z
  .object({
    id,
    name: z.string(),
    lifecycleState: Lifecycle,
    retiredAt: nullableTimestamp,
    version: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .openapi('Role');

export const Division = z
  .object({
    id,
    name: z.string(),
    defaultOpenings: z.number().int(),
    openingsLocked: z.boolean(),
    restrictClaims: z.boolean(),
    allowCustomTemplates: z.boolean(),
    lifecycleState: Lifecycle,
    retiredAt: nullableTimestamp,
    version: z.number().int(),
  })
  .strict()
  .openapi('Division');

export const Team = z
  .object({
    id,
    divisionId: id,
    name: z.string(),
    restrictClaims: z.boolean(),
    lifecycleState: Lifecycle,
    retiredAt: nullableTimestamp,
    version: z.number().int(),
  })
  .strict()
  .openapi('Team');

export const Member = z
  .object({ userId: id, source: z.enum(['patrice', 'integration']), createdAt: timestamp })
  .strict()
  .openapi('Member');

export const Grant = z
  .object({
    id,
    roleId: id,
    action: z.string(),
    effect: z.enum(['permit', 'forbid']),
    scopeKind: ScopeKind,
    scopeDivisionId: id.nullable(),
    scopeTeamId: id.nullable(),
    scopeRoleId: id.nullable(),
    version: z.number().int(),
  })
  .strict()
  .openapi('Grant');

export const ActionList = z.object({ actions: z.array(z.string()) }).strict().openapi('ActionList');

// ---- Work --------------------------------------------------------------------

export const ChoiceOption = z
  .object({ value: z.string(), label: z.string() })
  .strict()
  .openapi('ChoiceOption');

/** Per-type constraint bag; only the keys relevant to a question's type are set. */
export const QuestionConstraints = z
  .object({
    maxChars: z.number().int().optional(),
    minChars: z.number().int().optional(),
    kind: z.enum(['integer', 'float']).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    multi: z.boolean().optional(),
    options: z.array(ChoiceOption).optional(),
    minSelect: z.number().int().optional(),
    maxSelect: z.number().int().optional(),
    allowedTypes: z.array(z.string()).optional(),
    maxBytes: z.number().int().optional(),
    maxFiles: z.number().int().optional(),
  })
  .strict()
  .openapi('QuestionConstraints');

export const Question = z
  .object({
    id,
    ordinal: z.number().int(),
    type: QuestionType,
    prompt: z.string(),
    required: z.boolean(),
    constraints: QuestionConstraints,
  })
  .strict()
  .openapi('Question');

const templateHeader = {
  id,
  divisionId: id,
  name: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  version: z.number().int(),
};

/** A library template in a division, with its questions. */
export const RequestTemplate = z
  .object({ ...templateHeader, questions: z.array(Question) })
  .strict()
  .openapi('RequestTemplate');

export const RequestTemplateSummary = z
  .object({ ...templateHeader, questionCount: z.number().int() })
  .strict()
  .openapi('RequestTemplateSummary');

/** A division's library for the picker, and what the caller may do in the division. */
export const RequestTemplateLibrary = z
  .object({ items: z.array(RequestTemplateSummary), allowedActions: z.array(z.string()) })
  .strict()
  .openapi('RequestTemplateLibrary');

/** A task's own questions: a snapshot, locked once a live submission exists. */
export const TaskTemplate = z
  .object({
    taskId: id,
    origin: TemplateOrigin,
    sourceTemplateId: id.nullable(),
    locked: z.boolean(),
    questions: z.array(Question),
  })
  .strict()
  .openapi('TaskTemplate');

export const Task = z
  .object({
    id,
    name: z.string(),
    description: z.string(),
    divisionId: id,
    teamId: id.nullable(),
    requesterUserId: id,
    openings: z.number().int(),
    claimsClosed: z.boolean(),
    statusCache: TaskStatus,
    templateOrigin: TemplateOrigin,
    sourceTemplateId: id.nullable(),
    completedAt: nullableTimestamp,
    completedBy: id.nullable(),
    lifecycleState: Lifecycle,
    retiredAt: nullableTimestamp,
    version: z.number().int(),
    createdAt: timestamp,
    updatedAt: timestamp,
    claimantUserIds: z.array(id),
    allowedActions: z.array(z.string()).optional(),
  })
  .strict()
  .openapi('Task');

export const TaskListResult = z
  .object({ items: z.array(Task), nextCursor: z.string().nullable() })
  .strict()
  .openapi('TaskListResult');

export const Attachment = z
  .object({
    id,
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int(),
    kind: z.string(),
    uploaderUserId: id,
    createdAt: timestamp,
  })
  .strict()
  .openapi('Attachment');

export const AttachmentMeta = z
  .object({
    id,
    taskId: id,
    // Neither set: a pending upload, waiting for its uploader's submit to claim it.
    messageId: id.nullable(),
    answerId: id.nullable(),
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.number().int(),
    kind: z.string(),
    checksum: z.string().nullable(),
    uploaderUserId: id,
    createdAt: timestamp,
  })
  .strict()
  .openapi('AttachmentMeta');

const messageShape = {
  id,
  taskId: id,
  senderUserId: id.nullable(),
  parentMessageId: id.nullable(),
  // The submission this comment is about, if any.
  submissionId: id.nullable(),
  body: z.string(),
  // Set on a deleted message kept as a marker because it has replies.
  deletedAt: nullableTimestamp,
  editedAt: nullableTimestamp,
  version: z.number().int(),
  createdAt: timestamp,
  attachments: z.array(Attachment),
};

export const Reply = z.object(messageShape).strict().openapi('Reply');
export const Message = z
  .object({ ...messageShape, replies: z.array(Reply).optional() })
  .strict()
  .openapi('Message');

export const MessageListResult = z
  .object({ items: z.array(Message), nextCursor: z.string().nullable() })
  .strict()
  .openapi('MessageListResult');

export const Answer = z
  .object({ id, questionId: id, value: z.unknown(), attachmentIds: z.array(id) })
  .strict()
  .openapi('Answer');

export const Submission = z
  .object({
    id,
    taskId: id,
    claimantUserId: id,
    submissionNo: z.number().int(),
    prevSubmissionId: id.nullable(),
    state: SubmissionState,
    submittedAt: timestamp,
    reviewedBy: id.nullable(),
    reviewedAt: nullableTimestamp,
    lifecycleState: Lifecycle,
    version: z.number().int(),
    answers: z.array(Answer),
  })
  .strict()
  .openapi('Submission');

/**
 * One entry on a task's timeline: a typed event the client renders directly. The
 * union is built from the server's event catalog, so the two can't drift.
 */
export const TimelineEntry = z
  .discriminatedUnion(
    'type',
    TIMELINE_EVENT_TYPES.map((type) =>
      z
        .object({
          id,
          type: z.literal(type),
          actorUserId: id.nullable(),
          occurredAt: timestamp,
          payload: domainEventPayloadSchemas[type],
        })
        .strict(),
    ) as unknown as [z.AnyZodObject, z.AnyZodObject, ...z.AnyZodObject[]],
  )
  .openapi('TimelineEntry');

// ---- Awareness ---------------------------------------------------------------

export const Notification = z
  .object({
    id,
    type: z.string(),
    subjectType: z.string(),
    subjectId: id,
    payload: z.record(z.unknown()),
    readAt: nullableTimestamp,
    createdAt: timestamp,
  })
  .strict()
  .openapi('Notification');

export const NotificationListResult = z
  .object({ items: z.array(Notification), unreadCount: z.number().int(), nextCursor: z.string().nullable() })
  .strict()
  .openapi('NotificationListResult');

export const ActivityItem = z
  .object({
    id,
    actorUserId: id.nullable(),
    actorName: z.string().nullable(),
    subjectType: z.string(),
    subjectId: id,
    verb: z.string(),
    payload: z.record(z.unknown()),
    source: ActivitySource,
    createdAt: timestamp,
  })
  .strict()
  .openapi('ActivityItem');

export const ActivityListResult = z
  .object({ items: z.array(ActivityItem), nextCursor: z.string().nullable() })
  .strict()
  .openapi('ActivityListResult');

// ---- Integrations ------------------------------------------------------------

export const IntegrationConnection = z
  .object({
    id,
    provider: IntegrationProvider,
    externalWorkspaceId: z.string(),
    displayName: z.string(),
    status: IntegrationStatus,
    lifecycleState: Lifecycle,
    retiredAt: nullableTimestamp,
    gatewayState: GatewayState,
    gatewayLastConnectedAt: nullableTimestamp,
    gatewayLastEventAt: nullableTimestamp,
    syncState: SyncState,
    lastSyncStartedAt: nullableTimestamp,
    lastSyncAt: nullableTimestamp,
    lastSyncGranted: z.number().int(),
    lastSyncRevoked: z.number().int(),
    lastError: z.string().nullable(),
    nextReconcileAt: nullableTimestamp.optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .openapi('IntegrationConnection');

export const ExternalGroupMapping = z
  .object({
    id,
    roleId: id,
    connectionId: id,
    externalGroupId: z.string(),
    syncDirection: SyncDirection,
    isBroken: z.boolean(),
    conflictWinner: ConflictWinner,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict()
  .openapi('ExternalGroupMapping');

export const SyncQueued = z.object({ queued: z.literal(true) }).strict().openapi('SyncQueued');

// ---- Operations --------------------------------------------------------------

export const GcReport = z
  .object({
    tasks: z.array(id),
    divisions: z.array(id),
    teams: z.array(id),
    roles: z.array(id),
    usersScrubbed: z.array(id),
    usersDeleted: z.array(id),
    integrationConnections: z.array(id),
    blocked: z.array(z.object({ entityType: z.string(), entityId: id }).strict()),
    orphanedBlobs: z.number().int(),
    pendingUploads: z.number().int(),
  })
  .strict()
  .openapi('GcReport');

export const Health = z
  .object({ status: z.enum(['ok', 'degraded']), db: z.literal('ok'), queue: z.enum(['ok', 'down']) })
  .strict()
  .openapi('Health');

export const DeadLetter = z
  .object({ id: z.string(), queue: z.string(), failedAt: timestamp })
  .strict()
  .openapi('DeadLetter');
