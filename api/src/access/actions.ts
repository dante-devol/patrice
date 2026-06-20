/**
 * The closed Action vocabulary (`resource:verb`) — code-defined, admins cannot
 * invent new ones (docs/ARCHITECTURE.md §2.3). Slice 1 only *uses* a handful of
 * these via endpoints, but the governance actions (`grant:*`, `role:*`) are also
 * registered so the seeded Admin can hold them — that is what makes the Admin an
 * **effective admin** and lets bootstrap mode close (see EFFECTIVE_ADMIN_ACTIONS).
 *
 * Each action declares the Cedar **resource entity type** it applies to, which the
 * authorize guard uses to shape the request and the projector uses for schema text.
 */
export type CedarEntityType =
  | 'Organization'
  | 'Invitation'
  | 'User'
  | 'Session'
  | 'Task'
  | 'Message'
  | 'Attachment';

export interface ActionDef {
  /** `resource:verb` string — the Cedar action id and the grant.action value. */
  readonly action: string;
  /** Cedar entity type of the resource this action applies to. */
  readonly resourceType: CedarEntityType;
}

/**
 * The **full** closed vocabulary (docs/slices/02 "Action vocabulary"). Registered
 * with the engine in Slice 2.3 so the permission matrix can grant any action even
 * before its endpoint lands (tasks/messages/attachments arrive in Slices 4–5). The
 * `resourceType` shapes both the authorize request and the projection-time schema.
 */
export const ACTIONS = {
  // task:* — endpoints land in Slices 4–5; registered here for the matrix.
  taskCreate: { action: 'task:create', resourceType: 'Task' },
  taskUpdate: { action: 'task:update', resourceType: 'Task' },
  taskRetire: { action: 'task:retire', resourceType: 'Task' },
  taskRevive: { action: 'task:revive', resourceType: 'Task' },
  taskAssign: { action: 'task:assign', resourceType: 'Task' },
  taskSubmit: { action: 'task:submit', resourceType: 'Task' },
  taskReview: { action: 'task:review', resourceType: 'Task' },
  taskRetireSubmission: { action: 'task:retire_submission', resourceType: 'Task' },
  taskComplete: { action: 'task:complete', resourceType: 'Task' },
  taskConfigureQuestionnaire: { action: 'task:configure_questionnaire', resourceType: 'Task' },
  taskManageClaims: { action: 'task:manage_claims', resourceType: 'Task' },
  taskChangeRequester: { action: 'task:change_requester', resourceType: 'Task' },
  // message:* / attachment:*
  messageCreate: { action: 'message:create', resourceType: 'Message' },
  messageUpdate: { action: 'message:update', resourceType: 'Message' },
  messageRetire: { action: 'message:retire', resourceType: 'Message' },
  messageRevive: { action: 'message:revive', resourceType: 'Message' },
  attachmentCreate: { action: 'attachment:create', resourceType: 'Attachment' },
  attachmentRetire: { action: 'attachment:retire', resourceType: 'Attachment' },
  attachmentRevive: { action: 'attachment:revive', resourceType: 'Attachment' },
  // user:* — update is metadata; grant_role/revoke_role are role-scoped (Slice 2.4).
  userUpdate: { action: 'user:update', resourceType: 'User' },
  userRetire: { action: 'user:retire', resourceType: 'User' },
  userRevive: { action: 'user:revive', resourceType: 'User' },
  userDeactivate: { action: 'user:deactivate', resourceType: 'User' },
  userReactivate: { action: 'user:reactivate', resourceType: 'User' },
  userGrantRole: { action: 'user:grant_role', resourceType: 'User' },
  userRevokeRole: { action: 'user:revoke_role', resourceType: 'User' },
  // session:revoke — own=session's user (G/O); /auth/logout is gated by @ own.
  sessionRevoke: { action: 'session:revoke', resourceType: 'Session' },
  // invite:*
  inviteCreate: { action: 'invite:create', resourceType: 'Organization' },
  inviteRetire: { action: 'invite:retire', resourceType: 'Invitation' },
  // Governance actions — the singleton org is the resource (admin holds globals).
  grantCreate: { action: 'grant:create', resourceType: 'Organization' },
  grantUpdate: { action: 'grant:update', resourceType: 'Organization' },
  grantRetire: { action: 'grant:retire', resourceType: 'Organization' },
  grantRevive: { action: 'grant:revive', resourceType: 'Organization' },
  roleCreate: { action: 'role:create', resourceType: 'Organization' },
  roleUpdate: { action: 'role:update', resourceType: 'Organization' },
  roleRetire: { action: 'role:retire', resourceType: 'Organization' },
  roleRevive: { action: 'role:revive', resourceType: 'Organization' },
  // Division/Team config (Slice 2.2). Governance-scoped: the singleton org is the
  // resource for all of these (admin holds global grants), mirroring the role ops —
  // keeps revive clear of the Retired-as-Hard-Deny that targets the entity itself.
  divisionCreate: { action: 'division:create', resourceType: 'Organization' },
  divisionUpdate: { action: 'division:update', resourceType: 'Organization' },
  divisionRetire: { action: 'division:retire', resourceType: 'Organization' },
  divisionRevive: { action: 'division:revive', resourceType: 'Organization' },
  teamCreate: { action: 'team:create', resourceType: 'Organization' },
  teamUpdate: { action: 'team:update', resourceType: 'Organization' },
  teamRetire: { action: 'team:retire', resourceType: 'Organization' },
  teamRevive: { action: 'team:revive', resourceType: 'Organization' },
  // config:update — org settings editor (Slice 2.4).
  configUpdate: { action: 'config:update', resourceType: 'Organization' },
} as const satisfies Record<string, ActionDef>;

export type ActionKey = keyof typeof ACTIONS;

/** All registered action strings (for schema generation + Admin seeding). */
export const ALL_ACTION_STRINGS: readonly string[] = Object.values(ACTIONS).map(
  (a) => a.action,
);

/** Map action string → resource entity type. */
export const RESOURCE_TYPE_BY_ACTION: Readonly<Record<string, CedarEntityType>> =
  Object.fromEntries(Object.values(ACTIONS).map((a) => [a.action, a.resourceType]));

/**
 * Effective-admin governance actions — a `permit` grant on any of these at
 * `scope_kind='global'` (by an active user) makes that user an effective admin.
 * Single source of truth, read by bootstrap (Slice 1) and the administrability
 * invariant (Slice 2/7). Mirrors docs/slices/00-overview.md.
 */
export const EFFECTIVE_ADMIN_ACTIONS: readonly string[] = [
  'grant:create',
  'grant:update',
  'grant:retire',
  'role:create',
  'role:update',
  'role:retire',
];

/**
 * Actions the seeded Admin role receives at `scope_kind='global'` in Slice 1:
 * the invite endpoints it actually uses, plus the governance actions that make it
 * an effective admin. Later slices add more grants via the matrix UI.
 */
export const ADMIN_SEED_ACTIONS: readonly string[] = [
  'invite:create',
  'invite:retire',
  // `*:revive` actions are seeded with global-scoped Admin grants by default
  // (docs/slices/02 action vocabulary); narrower revive authority is delegated
  // via the matrix. Slice 2 seeds role/division/team management for the admin.
  'role:revive',
  'division:create',
  'division:update',
  'division:retire',
  'division:revive',
  'team:create',
  'team:update',
  'team:retire',
  'team:revive',
  // Matrix + membership + settings authority (Slices 2.3–2.4).
  'grant:revive',
  'config:update',
  'user:update',
  'user:retire',
  'user:revive',
  'user:deactivate',
  'user:reactivate',
  'user:grant_role',
  'user:revoke_role',
  ...EFFECTIVE_ADMIN_ACTIONS,
];
