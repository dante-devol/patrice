/**
 * The closed Action vocabulary (`resource:verb`). It's defined in code; admins can't
 * invent actions, only grant these.
 *
 * Each action declares the Cedar **resource entity type** it applies to. Creating
 * something targets the thing it is created in (a task in a Division, a message on a
 * Task, an attachment on a Message), so no resource is ever a made-up id.
 */
export type CedarEntityType =
  | 'Organization'
  | 'Invitation'
  | 'User'
  | 'Session'
  | 'Task'
  | 'Message'
  | 'Attachment'
  | 'Division'
  | 'Team'
  | 'Role';

export interface ActionDef {
  /** `resource:verb` string — the Cedar action id and the grant.action value. */
  readonly action: string;
  /** Cedar entity type of the resource this action applies to. */
  readonly resourceType: CedarEntityType;
}

export const ACTIONS = {
  // ---- Tasks. Reads of a task's parts (thread, submissions, files) target the task.
  taskRead: { action: 'task:read', resourceType: 'Task' },
  messageRead: { action: 'message:read', resourceType: 'Task' },
  submissionRead: { action: 'submission:read', resourceType: 'Task' },
  attachmentRead: { action: 'attachment:read', resourceType: 'Task' },
  taskCreate: { action: 'task:create', resourceType: 'Division' },
  taskUpdate: { action: 'task:update', resourceType: 'Task' },
  taskRetire: { action: 'task:retire', resourceType: 'Task' },
  taskRevive: { action: 'task:revive', resourceType: 'Task' },
  taskAssign: { action: 'task:assign', resourceType: 'Task' },
  taskLeave: { action: 'task:leave', resourceType: 'Task' },
  taskSubmit: { action: 'task:submit', resourceType: 'Task' },
  taskReview: { action: 'task:review', resourceType: 'Task' },
  taskRetireSubmission: { action: 'task:retire_submission', resourceType: 'Task' },
  taskComplete: { action: 'task:complete', resourceType: 'Task' },
  taskConfigureRequestTemplate: { action: 'task:configure_request_template', resourceType: 'Task' },
  taskManageClaims: { action: 'task:manage_claims', resourceType: 'Task' },
  taskChangeRequester: { action: 'task:change_requester', resourceType: 'Task' },
  /** Exempts a principal from the `requireDiscordLink` gate on task access. */
  taskBypassDiscordGate: { action: 'task:bypass_discord_gate', resourceType: 'Organization' },
  // ---- Messages and attachments.
  messageCreate: { action: 'message:create', resourceType: 'Task' },
  messageUpdate: { action: 'message:update', resourceType: 'Message' },
  // Messages, attachments and grants are deleted outright (with an audit row); only
  // tasks, users, units, roles and connections have retire → grace → revive.
  messageDelete: { action: 'message:delete', resourceType: 'Message' },
  attachmentCreate: { action: 'attachment:create', resourceType: 'Message' },
  attachmentDelete: { action: 'attachment:delete', resourceType: 'Attachment' },
  // ---- Users.
  userRead: { action: 'user:read', resourceType: 'User' },
  userUpdate: { action: 'user:update', resourceType: 'User' },
  userRetire: { action: 'user:retire', resourceType: 'User' },
  userRevive: { action: 'user:revive', resourceType: 'User' },
  userDeactivate: { action: 'user:deactivate', resourceType: 'User' },
  userReactivate: { action: 'user:reactivate', resourceType: 'User' },
  userGrantRole: { action: 'user:grant_role', resourceType: 'User' },
  userRevokeRole: { action: 'user:revoke_role', resourceType: 'User' },
  sessionRevoke: { action: 'session:revoke', resourceType: 'Session' },
  // ---- Invitations.
  inviteCreate: { action: 'invite:create', resourceType: 'Organization' },
  inviteRetire: { action: 'invite:retire', resourceType: 'Invitation' },
  // ---- Governance: the permission matrix. Org-wide by nature.
  grantCreate: { action: 'grant:create', resourceType: 'Organization' },
  grantUpdate: { action: 'grant:update', resourceType: 'Organization' },
  grantDelete: { action: 'grant:delete', resourceType: 'Organization' },
  roleRead: { action: 'role:read', resourceType: 'Role' },
  roleCreate: { action: 'role:create', resourceType: 'Organization' },
  roleUpdate: { action: 'role:update', resourceType: 'Organization' },
  roleRetire: { action: 'role:retire', resourceType: 'Organization' },
  roleRevive: { action: 'role:revive', resourceType: 'Organization' },
  // ---- Divisions and teams. Everything but creating a division targets the unit
  //      itself, so a division admin can be granted `specific_division` authority.
  divisionRead: { action: 'division:read', resourceType: 'Division' },
  divisionCreate: { action: 'division:create', resourceType: 'Organization' },
  divisionUpdate: { action: 'division:update', resourceType: 'Division' },
  divisionRetire: { action: 'division:retire', resourceType: 'Division' },
  divisionRevive: { action: 'division:revive', resourceType: 'Division' },
  divisionManageMembers: { action: 'division:manage_members', resourceType: 'Division' },
  requestTemplateRead: { action: 'request_template:read', resourceType: 'Division' },
  teamRead: { action: 'team:read', resourceType: 'Team' },
  teamCreate: { action: 'team:create', resourceType: 'Division' },
  teamUpdate: { action: 'team:update', resourceType: 'Team' },
  teamRetire: { action: 'team:retire', resourceType: 'Team' },
  teamRevive: { action: 'team:revive', resourceType: 'Team' },
  teamManageMembers: { action: 'team:manage_members', resourceType: 'Team' },
  // ---- System.
  configUpdate: { action: 'config:update', resourceType: 'Organization' },
  integrationCreate: { action: 'integration:create', resourceType: 'Organization' },
  integrationUpdate: { action: 'integration:update', resourceType: 'Organization' },
  integrationRetire: { action: 'integration:retire', resourceType: 'Organization' },
  integrationRevive: { action: 'integration:revive', resourceType: 'Organization' },
} as const satisfies Record<string, ActionDef>;

export type ActionKey = keyof typeof ACTIONS;

/** All registered action strings (for schema generation and Admin seeding). */
export const ALL_ACTION_STRINGS: readonly string[] = Object.values(ACTIONS).map((a) => a.action);

/** Map action string → resource entity type. */
export const RESOURCE_TYPE_BY_ACTION: Readonly<Record<string, CedarEntityType>> =
  Object.fromEntries(Object.values(ACTIONS).map((a) => [a.action, a.resourceType]));

/** Actions gated by `requireDiscordLink` (task access, reads included). */
export const TASK_FAMILY_ACTIONS: readonly string[] = Object.values(ACTIONS)
  .filter((a) => ['Task', 'Message', 'Attachment'].includes(a.resourceType) || a.action === 'task:create')
  .map((a) => a.action);

/**
 * Effective-admin governance actions. The administrability invariant requires at
 * least one active user whom Cedar permits *all* of these org-wide.
 */
export const EFFECTIVE_ADMIN_ACTIONS: readonly string[] = [
  'grant:create',
  'grant:update',
  'grant:delete',
  'role:create',
  'role:update',
  'role:retire',
];

/** The seeded Admin role holds every action at global scope, new ones included. */
export const ADMIN_SEED_ACTIONS: readonly string[] = ALL_ACTION_STRINGS;

/**
 * The seeded Member role: see names, do work on your own tasks. Editable like any
 * role; new invitations pre-assign it.
 */
export const MEMBER_SEED_GRANTS: ReadonlyArray<{ action: string; scopeKind: 'global' | 'own' | 'own_division' }> = [
  // Names and structure, so the client can render people and units.
  { action: 'user:read', scopeKind: 'global' },
  { action: 'division:read', scopeKind: 'global' },
  { action: 'team:read', scopeKind: 'global' },
  { action: 'role:read', scopeKind: 'global' },
  { action: 'request_template:read', scopeKind: 'global' },
  // Tasks you can see: your own, ones you hold a seat on, and ones you could claim.
  { action: 'task:read', scopeKind: 'own' },
  { action: 'message:read', scopeKind: 'own' },
  { action: 'submission:read', scopeKind: 'own' },
  { action: 'attachment:read', scopeKind: 'own' },
  // Doing the work.
  { action: 'task:assign', scopeKind: 'own' },
  { action: 'task:leave', scopeKind: 'own' },
  { action: 'task:submit', scopeKind: 'own' },
  { action: 'message:create', scopeKind: 'own' },
  { action: 'message:update', scopeKind: 'own' },
  { action: 'message:delete', scopeKind: 'own' },
  { action: 'attachment:create', scopeKind: 'own' },
  { action: 'attachment:delete', scopeKind: 'own' },
  // Requesting work in your divisions, and running the tasks you requested.
  { action: 'task:create', scopeKind: 'own_division' },
  { action: 'task:update', scopeKind: 'own' },
  { action: 'task:retire', scopeKind: 'own' },
  { action: 'task:review', scopeKind: 'own' },
  { action: 'task:retire_submission', scopeKind: 'own' },
  { action: 'task:complete', scopeKind: 'own' },
  { action: 'task:manage_claims', scopeKind: 'own' },
  { action: 'task:configure_request_template', scopeKind: 'own' },
];
