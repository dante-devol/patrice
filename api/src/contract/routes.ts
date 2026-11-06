import { z, ZodTypeAny } from 'zod';
import * as S from './schemas';
import { listActivityQuerySchema } from '../activity/activity.dto';
import {
  acceptInviteSchema,
  confirmEmailChangeSchema,
  confirmVerificationSchema,
  createInvitationSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  requestEmailChangeSchema,
  resendVerificationSchema,
  setPasswordSchema,
} from '../auth/auth.dto';
import { createDivisionSchema, updateDivisionSchema } from '../divisions/divisions.dto';
import { assignUnitRoleSchema } from '../unit-roles/unit-roles.dto';
import { unitStatsQuerySchema } from '../unit-stats/unit-stats.dto';
import { batchGrantsSchema, createGrantSchema, updateGrantSchema } from '../grants/grants.dto';
import {
  connectIntegrationSchema,
  createMappingSchema,
  deleteMappingSchema,
  retireIntegrationSchema,
  rotateTokenSchema,
  updateIntegrationSchema,
  updateMappingSchema,
} from '../integrations/integrations.dto';
import { createMessageSchema, listMessagesQuerySchema, updateMessageSchema } from '../messages/messages.dto';
import { listNotificationsQuerySchema } from '../notifications/notifications.dto';
import {
  createRequestTemplateSchema,
  putRequestTemplateSchema,
  updateRequestTemplateSchema,
} from '../request-templates/request-templates.dto';
import { createRoleSchema, updateRoleSchema } from '../roles/roles.dto';
import { retireSubmissionSchema, reviewSchema, submitSchema } from '../submissions/submissions.dto';
import {
  changeRequesterSchema,
  createTaskSchema,
  listTasksQuerySchema,
  manageClaimsSchema,
  updateTaskSchema,
} from '../tasks/tasks.dto';
import { createTeamSchema, updateTeamSchema } from '../teams/teams.dto';
import { addMemberSchema } from '../membership/membership.dto';
import { grantRoleSchema, updateConfigSchema, updateUserSchema } from '../users/users.dto';

/**
 * How a route answers:
 * - `json`: a JSON body matching `response`
 * - `empty`: no body (204)
 * - `redirect`: a 302 to the web app
 * - `binary`: a file stream
 * - `sse`: a server-sent event stream
 */
export type ResponseKind = 'json' | 'empty' | 'redirect' | 'binary' | 'sse';

export interface ContractRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Express-style path under `/api`, e.g. `/divisions/:id`. */
  path: string;
  tag: string;
  summary: string;
  /** Reachable without a session. */
  public?: boolean;
  /** The Cedar action that gates the route at the edge, when one does. */
  action?: string;
  /**
   * The Cedar action the service checks itself, when the route can't: the target
   * comes from the validated body (create a task in a division), or a list is
   * filtered per row.
   */
  authorizedInService?: string;
  body?: ZodTypeAny;
  /** `multipart/form-data` upload with a single `file` field. */
  upload?: boolean;
  query?: ZodTypeAny;
  status: number;
  kind: ResponseKind;
  response?: ZodTypeAny;
}

const includeRetired = z.object({ include: z.enum(['retired']).optional() });

function r(route: ContractRoute): ContractRoute {
  return route;
}

/**
 * Every HTTP route the API serves. Each controller handler carries
 * `@Contract(ROUTES.x)`; a test checks the two lists match exactly.
 */
export const ROUTES = {
  // ---- Platform ----
  health: r({ method: 'get', path: '/health', tag: 'platform', summary: 'Liveness, database and job queue check', public: true, status: 200, kind: 'json', response: S.Health }),
  listDeadLetters: r({ method: 'get', path: '/jobs/dead-letters', tag: 'platform', summary: 'Background jobs that ran out of retries', action: 'job:read', status: 200, kind: 'json', response: z.array(S.DeadLetter) }),

  // ---- Auth ----
  login: r({ method: 'post', path: '/auth/login', tag: 'auth', summary: 'Sign in with email and password', public: true, body: loginSchema, status: 200, kind: 'json', response: S.CurrentUser }),
  logout: r({ method: 'post', path: '/auth/logout', tag: 'auth', summary: 'End the current session', public: true, status: 204, kind: 'empty' }),
  me: r({ method: 'get', path: '/me', tag: 'auth', summary: 'The signed-in user', status: 200, kind: 'json', response: S.CurrentUser }),
  resendVerification: r({ method: 'post', path: '/auth/verify-email/resend', tag: 'auth', summary: 'Resend the email verification link', public: true, body: resendVerificationSchema, status: 200, kind: 'json', response: S.Ok }),
  confirmVerification: r({ method: 'post', path: '/auth/verify-email/confirm', tag: 'auth', summary: 'Confirm an email address', public: true, body: confirmVerificationSchema, status: 200, kind: 'json', response: S.Ok }),
  requestPasswordReset: r({ method: 'post', path: '/auth/password-reset', tag: 'auth', summary: 'Email a password reset link', public: true, body: passwordResetRequestSchema, status: 200, kind: 'json', response: S.Ok }),
  confirmPasswordReset: r({ method: 'post', path: '/auth/password-reset/confirm', tag: 'auth', summary: 'Set a new password from a reset link', public: true, body: passwordResetConfirmSchema, status: 200, kind: 'json', response: S.Ok }),

  // ---- Self-service account ----
  setPassword: r({ method: 'post', path: '/me/password', tag: 'auth', summary: 'Change your password, or add one to a provider-only account', body: setPasswordSchema, status: 204, kind: 'empty' }),
  requestEmailChange: r({ method: 'post', path: '/me/email', tag: 'auth', summary: 'Start changing your email (confirmed from the new address)', body: requestEmailChangeSchema, status: 200, kind: 'json', response: S.Ok }),
  confirmEmailChange: r({ method: 'post', path: '/auth/email-change/confirm', tag: 'auth', summary: 'Confirm an email change', public: true, body: confirmEmailChangeSchema, status: 200, kind: 'json', response: S.Ok }),
  myUnits: r({ method: 'get', path: '/me/units', tag: 'auth', summary: 'The divisions and teams you belong to or lead', status: 200, kind: 'json', response: z.array(S.MyUnit) }),
  listMySessions: r({ method: 'get', path: '/me/sessions', tag: 'auth', summary: 'Your signed-in sessions', status: 200, kind: 'json', response: z.array(S.Session) }),
  listUserSessions: r({ method: 'get', path: '/users/:id/sessions', tag: 'auth', summary: "A user's signed-in sessions", action: 'session:revoke', status: 200, kind: 'json', response: z.array(S.Session) }),
  revokeSession: r({ method: 'delete', path: '/sessions/:id', tag: 'auth', summary: 'Sign a session out (your own, or any with a grant)', action: 'session:revoke', status: 204, kind: 'empty' }),

  // ---- Sign-in providers (e.g. `discord`) ----
  oauthLogin: r({ method: 'get', path: '/auth/:provider/login', tag: 'auth', summary: 'Start signing in with a provider', public: true, status: 302, kind: 'redirect' }),
  oauthRegister: r({ method: 'get', path: '/auth/:provider/register', tag: 'auth', summary: 'Start registering from an invitation with a provider', public: true, query: z.object({ invite: z.string().optional() }), status: 302, kind: 'redirect' }),
  oauthLink: r({ method: 'get', path: '/auth/:provider/link', tag: 'auth', summary: 'Start connecting a provider to the signed-in account', public: true, status: 302, kind: 'redirect' }),
  oauthCallback: r({ method: 'get', path: '/auth/:provider/callback', tag: 'auth', summary: "A provider's OAuth callback", public: true, query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), status: 302, kind: 'redirect' }),
  oauthUnlink: r({ method: 'delete', path: '/auth/:provider', tag: 'auth', summary: 'Disconnect a provider from the signed-in account', status: 200, kind: 'json', response: S.CurrentUser }),

  // ---- Invitations ----
  bootstrapStatus: r({ method: 'get', path: '/bootstrap', tag: 'invitations', summary: 'Whether first-run setup is open', public: true, status: 200, kind: 'json', response: S.BootstrapStatus }),
  viewInvite: r({ method: 'get', path: '/invite/:token', tag: 'invitations', summary: 'Inspect an invitation before accepting it', public: true, status: 200, kind: 'json', response: S.InviteView }),
  acceptInvite: r({ method: 'post', path: '/invite/:token/accept', tag: 'invitations', summary: 'Accept an invitation and create an account', public: true, body: acceptInviteSchema, status: 201, kind: 'json', response: S.CurrentUser }),
  createInvitation: r({ method: 'post', path: '/invitations', tag: 'invitations', summary: 'Create an invitation', action: 'invite:create', body: createInvitationSchema, status: 201, kind: 'json', response: S.CreatedInvitation }),
  listInvitations: r({ method: 'get', path: '/invitations', tag: 'invitations', summary: 'List invitations', action: 'invite:create', status: 200, kind: 'json', response: z.array(S.InvitationListItem) }),
  revokeInvitation: r({ method: 'post', path: '/invitations/:id/revoke', tag: 'invitations', summary: 'Revoke an invitation', action: 'invite:retire', status: 204, kind: 'empty' }),

  // ---- Users & settings ----
  listUsers: r({ method: 'get', path: '/users', tag: 'users', summary: 'List users', query: includeRetired, authorizedInService: 'user:read', status: 200, kind: 'json', response: z.array(S.AdminUser) }),
  updateUser: r({ method: 'patch', path: '/users/:id', tag: 'users', summary: "Edit a user's profile", action: 'user:update', body: updateUserSchema, status: 200, kind: 'json', response: z.object({ id: z.string().uuid(), displayName: z.string() }).strict() }),
  deactivateUser: r({ method: 'post', path: '/users/:id/deactivate', tag: 'users', summary: 'Deactivate a user', action: 'user:deactivate', status: 204, kind: 'empty' }),
  reactivateUser: r({ method: 'post', path: '/users/:id/reactivate', tag: 'users', summary: 'Reactivate a user', action: 'user:reactivate', status: 204, kind: 'empty' }),
  retireUser: r({ method: 'post', path: '/users/:id/retire', tag: 'users', summary: 'Retire a user', action: 'user:retire', status: 204, kind: 'empty' }),
  reviveUser: r({ method: 'post', path: '/users/:id/revive', tag: 'users', summary: 'Revive a retired user', action: 'user:revive', status: 204, kind: 'empty' }),
  grantUserRole: r({ method: 'post', path: '/users/:id/roles', tag: 'users', summary: 'Give a user a role', action: 'user:grant_role', body: grantRoleSchema, status: 204, kind: 'empty' }),
  revokeUserRole: r({ method: 'delete', path: '/users/:id/roles/:roleId', tag: 'users', summary: 'Take a role from a user', action: 'user:revoke_role', status: 204, kind: 'empty' }),
  getConfig: r({ method: 'get', path: '/config', tag: 'users', summary: 'Read system settings', action: 'config:update', status: 200, kind: 'json', response: S.OrgSettings }),
  updateConfig: r({ method: 'patch', path: '/config', tag: 'users', summary: 'Edit system settings', action: 'config:update', body: updateConfigSchema, status: 200, kind: 'json', response: S.OrgSettings }),

  // ---- Roles, grants ----
  listRoles: r({ method: 'get', path: '/roles', tag: 'access', summary: 'List roles', query: includeRetired, authorizedInService: 'role:read', status: 200, kind: 'json', response: z.array(S.Role) }),
  createRole: r({ method: 'post', path: '/roles', tag: 'access', summary: 'Create a role', action: 'role:create', body: createRoleSchema, status: 201, kind: 'json', response: S.Role }),
  updateRole: r({ method: 'patch', path: '/roles/:id', tag: 'access', summary: 'Rename a role', action: 'role:update', body: updateRoleSchema, status: 200, kind: 'json', response: S.Role }),
  retireRole: r({ method: 'post', path: '/roles/:id/retire', tag: 'access', summary: 'Retire a role', action: 'role:retire', status: 201, kind: 'json', response: S.Role }),
  reviveRole: r({ method: 'post', path: '/roles/:id/revive', tag: 'access', summary: 'Revive a retired role', action: 'role:revive', status: 201, kind: 'json', response: S.Role }),
  listActions: r({ method: 'get', path: '/actions', tag: 'access', summary: 'The closed action vocabulary', action: 'grant:create', status: 200, kind: 'json', response: S.ActionList }),
  listGrants: r({ method: 'get', path: '/grants', tag: 'access', summary: 'List grants', action: 'grant:create', status: 200, kind: 'json', response: z.array(S.Grant) }),
  createGrant: r({ method: 'post', path: '/grants', tag: 'access', summary: 'Create a grant', action: 'grant:create', body: createGrantSchema, status: 201, kind: 'json', response: S.Grant }),
  batchGrants: r({ method: 'post', path: '/grants/batch', tag: 'access', summary: "Apply the permission editor's staged changes, all or nothing", action: 'grant:update', body: batchGrantsSchema, status: 200, kind: 'json', response: z.array(S.Grant) }),
  updateGrant: r({ method: 'patch', path: '/grants/:id', tag: 'access', summary: 'Edit a grant', action: 'grant:update', body: updateGrantSchema, status: 200, kind: 'json', response: S.Grant }),
  deleteGrant: r({ method: 'delete', path: '/grants/:id', tag: 'access', summary: 'Delete a grant (permanent, audited)', action: 'grant:delete', status: 204, kind: 'empty' }),

  // ---- Divisions, teams ----
  listDivisions: r({ method: 'get', path: '/divisions', tag: 'org', summary: 'List divisions', query: includeRetired, authorizedInService: 'division:read', status: 200, kind: 'json', response: z.array(S.Division) }),
  createDivision: r({ method: 'post', path: '/divisions', tag: 'org', summary: 'Create a division', action: 'division:create', body: createDivisionSchema, status: 201, kind: 'json', response: S.Division }),
  updateDivision: r({ method: 'patch', path: '/divisions/:id', tag: 'org', summary: 'Edit a division', action: 'division:update', body: updateDivisionSchema, status: 200, kind: 'json', response: S.Division }),
  retireDivision: r({ method: 'post', path: '/divisions/:id/retire', tag: 'org', summary: 'Retire a division', action: 'division:retire', status: 201, kind: 'json', response: S.Division }),
  reviveDivision: r({ method: 'post', path: '/divisions/:id/revive', tag: 'org', summary: 'Revive a retired division', action: 'division:revive', status: 201, kind: 'json', response: S.Division }),
  listDivisionTemplates: r({ method: 'get', path: '/divisions/:id/request-templates', tag: 'templates', summary: "A division's template library", action: 'request_template:read', status: 200, kind: 'json', response: S.RequestTemplateLibrary }),
  createDivisionTemplate: r({ method: 'post', path: '/divisions/:id/request-templates', tag: 'templates', summary: 'Add a template to a division library', action: 'request_template:create', body: createRequestTemplateSchema, status: 201, kind: 'json', response: S.RequestTemplate }),
  getRequestTemplate: r({ method: 'get', path: '/request-templates/:id', tag: 'templates', summary: 'A library template', action: 'request_template:read', status: 200, kind: 'json', response: S.RequestTemplate }),
  updateRequestTemplate: r({ method: 'patch', path: '/request-templates/:id', tag: 'templates', summary: 'Edit a library template (questions diffed by id)', action: 'request_template:update', body: updateRequestTemplateSchema, status: 200, kind: 'json', response: S.RequestTemplate }),
  deleteRequestTemplate: r({ method: 'delete', path: '/request-templates/:id', tag: 'templates', summary: 'Delete a library template (permanent, audited; tasks keep their snapshots)', action: 'request_template:delete', status: 204, kind: 'empty' }),
  listDivisionMembers: r({ method: 'get', path: '/divisions/:id/members', tag: 'org', summary: "A division's members", action: 'division:read', status: 200, kind: 'json', response: z.array(S.Member) }),
  addDivisionMember: r({ method: 'post', path: '/divisions/:id/members', tag: 'org', summary: 'Add a member to a division', action: 'division:manage_members', body: addMemberSchema, status: 200, kind: 'json', response: z.array(S.Member) }),
  removeDivisionMember: r({ method: 'delete', path: '/divisions/:id/members/:userId', tag: 'org', summary: 'Remove a member from a division', action: 'division:manage_members', status: 204, kind: 'empty' }),
  listTeamMembers: r({ method: 'get', path: '/teams/:id/members', tag: 'org', summary: "A team's members", action: 'team:read', status: 200, kind: 'json', response: z.array(S.Member) }),
  addTeamMember: r({ method: 'post', path: '/teams/:id/members', tag: 'org', summary: 'Add a member to a team', action: 'team:manage_members', body: addMemberSchema, status: 200, kind: 'json', response: z.array(S.Member) }),
  removeTeamMember: r({ method: 'delete', path: '/teams/:id/members/:userId', tag: 'org', summary: 'Remove a member from a team', action: 'team:manage_members', status: 204, kind: 'empty' }),
  listDivisionRoleAssignments: r({ method: 'get', path: '/divisions/:id/role-assignments', tag: 'org', summary: "Who holds unit roles at a division", action: 'division:read', status: 200, kind: 'json', response: z.array(S.UnitRoleAssignment) }),
  divisionAssignableRoles: r({ method: 'get', path: '/divisions/:id/assignable-roles', tag: 'org', summary: 'The unit roles you may assign at a division', action: 'division:read', status: 200, kind: 'json', response: z.array(S.AssignableRole) }),
  assignDivisionRole: r({ method: 'post', path: '/divisions/:id/role-assignments', tag: 'org', summary: 'Assign a unit role at a division (adds membership if missing)', body: assignUnitRoleSchema, authorizedInService: 'division:assign_roles', status: 201, kind: 'json', response: S.UnitRoleAssignment }),
  unassignDivisionRole: r({ method: 'delete', path: '/divisions/:id/role-assignments/:assignmentId', tag: 'org', summary: 'Remove a unit role assignment at a division (membership stays)', authorizedInService: 'division:assign_roles', status: 204, kind: 'empty' }),
  listTeamRoleAssignments: r({ method: 'get', path: '/teams/:id/role-assignments', tag: 'org', summary: "Who holds unit roles at a team", action: 'team:read', status: 200, kind: 'json', response: z.array(S.UnitRoleAssignment) }),
  teamAssignableRoles: r({ method: 'get', path: '/teams/:id/assignable-roles', tag: 'org', summary: 'The unit roles you may assign at a team', action: 'team:read', status: 200, kind: 'json', response: z.array(S.AssignableRole) }),
  assignTeamRole: r({ method: 'post', path: '/teams/:id/role-assignments', tag: 'org', summary: 'Assign a unit role at a team (adds membership if missing)', body: assignUnitRoleSchema, authorizedInService: 'team:assign_roles', status: 201, kind: 'json', response: S.UnitRoleAssignment }),
  unassignTeamRole: r({ method: 'delete', path: '/teams/:id/role-assignments/:assignmentId', tag: 'org', summary: 'Remove a unit role assignment at a team (membership stays)', authorizedInService: 'team:assign_roles', status: 204, kind: 'empty' }),
  divisionStats: r({ method: 'get', path: '/divisions/:id/stats', tag: 'org', summary: "A division's stats (with its teams), over the tasks you can see", action: 'division:read', query: unitStatsQuerySchema, status: 200, kind: 'json', response: S.UnitStats }),
  teamStats: r({ method: 'get', path: '/teams/:id/stats', tag: 'org', summary: "A team's stats, over the tasks you can see", action: 'team:read', query: unitStatsQuerySchema, status: 200, kind: 'json', response: S.UnitStats }),
  listTeams: r({ method: 'get', path: '/teams', tag: 'org', summary: 'List teams', query: includeRetired, authorizedInService: 'team:read', status: 200, kind: 'json', response: z.array(S.Team) }),
  createTeam: r({ method: 'post', path: '/teams', tag: 'org', summary: 'Create a team', body: createTeamSchema, authorizedInService: 'team:create', status: 201, kind: 'json', response: S.Team }),
  updateTeam: r({ method: 'patch', path: '/teams/:id', tag: 'org', summary: 'Edit a team', action: 'team:update', body: updateTeamSchema, status: 200, kind: 'json', response: S.Team }),
  retireTeam: r({ method: 'post', path: '/teams/:id/retire', tag: 'org', summary: 'Retire a team', action: 'team:retire', status: 201, kind: 'json', response: S.Team }),
  reviveTeam: r({ method: 'post', path: '/teams/:id/revive', tag: 'org', summary: 'Revive a retired team', action: 'team:revive', status: 201, kind: 'json', response: S.Team }),

  // ---- Tasks ----
  listTasks: r({ method: 'get', path: '/tasks', tag: 'tasks', summary: 'List tasks', query: listTasksQuerySchema, authorizedInService: 'task:read', status: 200, kind: 'json', response: S.TaskListResult }),
  createTask: r({ method: 'post', path: '/tasks', tag: 'tasks', summary: 'Create a task', body: createTaskSchema, authorizedInService: 'task:create', status: 201, kind: 'json', response: S.Task }),
  getTask: r({ method: 'get', path: '/tasks/:id', tag: 'tasks', summary: 'A task', action: 'task:read', status: 200, kind: 'json', response: S.Task }),
  updateTask: r({ method: 'patch', path: '/tasks/:id', tag: 'tasks', summary: "Edit a task's name or description", action: 'task:update', body: updateTaskSchema, status: 200, kind: 'json', response: S.Task }),
  retireTask: r({ method: 'post', path: '/tasks/:id/retire', tag: 'tasks', summary: 'Retire a task', action: 'task:retire', status: 201, kind: 'json', response: S.Task }),
  reviveTask: r({ method: 'post', path: '/tasks/:id/revive', tag: 'tasks', summary: 'Revive a retired task', action: 'task:revive', status: 200, kind: 'json', response: S.Task }),
  claimTask: r({ method: 'post', path: '/tasks/:id/claim', tag: 'tasks', summary: 'Take a seat on a task', action: 'task:assign', status: 200, kind: 'json', response: S.Task }),
  leaveTask: r({ method: 'post', path: '/tasks/:id/leave', tag: 'tasks', summary: 'Give up your seat on a task', action: 'task:leave', status: 200, kind: 'json', response: S.Task }),
  removeClaimant: r({ method: 'delete', path: '/tasks/:id/claimants/:userId', tag: 'tasks', summary: 'Evict a claimant', action: 'task:manage_claims', status: 200, kind: 'json', response: S.Task }),
  manageClaims: r({ method: 'post', path: '/tasks/:id/claims', tag: 'tasks', summary: 'Change openings or close claims', action: 'task:manage_claims', body: manageClaimsSchema, status: 200, kind: 'json', response: S.Task }),
  changeRequester: r({ method: 'post', path: '/tasks/:id/requester', tag: 'tasks', summary: "Hand a task to another requester", action: 'task:change_requester', body: changeRequesterSchema, status: 200, kind: 'json', response: S.Task }),
  completeTask: r({ method: 'post', path: '/tasks/:id/complete', tag: 'tasks', summary: 'Mark a task complete', action: 'task:complete', status: 200, kind: 'json', response: S.Task }),
  getTaskTemplate: r({ method: 'get', path: '/tasks/:id/request-template', tag: 'tasks', summary: "A task's own questions", action: 'task:read', status: 200, kind: 'json', response: S.TaskTemplate }),
  getTaskTimeline: r({ method: 'get', path: '/tasks/:id/timeline', tag: 'tasks', summary: "What happened on a task, as typed events", action: 'task:read', status: 200, kind: 'json', response: z.array(S.TimelineEntry) }),
  putTaskTemplate: r({ method: 'put', path: '/tasks/:id/request-template', tag: 'tasks', summary: "Edit a task's own questions (diffed by id; locked by a submission)", action: 'task:configure_request_template', body: putRequestTemplateSchema, status: 200, kind: 'json', response: S.TaskTemplate }),

  // ---- Submissions ----
  uploadAnswerFile: r({ method: 'post', path: '/tasks/:id/uploads', tag: 'submissions', summary: 'Upload a file for an attachment answer (pending until your submit claims it)', action: 'task:submit', upload: true, status: 201, kind: 'json', response: S.AttachmentMeta }),
  submit: r({ method: 'post', path: '/tasks/:id/submissions', tag: 'submissions', summary: 'Submit answers', action: 'task:submit', body: submitSchema, status: 201, kind: 'json', response: S.Submission }),
  listSubmissions: r({ method: 'get', path: '/tasks/:id/submissions', tag: 'submissions', summary: "A task's submissions", action: 'submission:read', status: 200, kind: 'json', response: z.array(S.Submission) }),
  getSubmission: r({ method: 'get', path: '/submissions/:id', tag: 'submissions', summary: 'A submission', action: 'submission:read', status: 200, kind: 'json', response: S.Submission }),
  reviewSubmission: r({ method: 'post', path: '/submissions/:id/review', tag: 'submissions', summary: 'Approve, return or reject a submission', action: 'task:review', body: reviewSchema, status: 200, kind: 'json', response: S.Submission }),
  retireSubmission: r({ method: 'post', path: '/submissions/:id/retire', tag: 'submissions', summary: 'Remove a submission (moderation)', action: 'task:retire_submission', body: retireSubmissionSchema, status: 200, kind: 'json', response: S.Submission }),

  // ---- Messages, attachments ----
  listMessages: r({ method: 'get', path: '/tasks/:id/messages', tag: 'messages', summary: "A task's thread", query: listMessagesQuerySchema, action: 'message:read', status: 200, kind: 'json', response: S.MessageListResult }),
  createMessage: r({ method: 'post', path: '/tasks/:id/messages', tag: 'messages', summary: 'Post a message', action: 'message:create', body: createMessageSchema, status: 201, kind: 'json', response: S.Message }),
  updateMessage: r({ method: 'patch', path: '/messages/:id', tag: 'messages', summary: 'Edit a message', action: 'message:update', body: updateMessageSchema, status: 200, kind: 'json', response: S.Message }),
  deleteMessage: r({ method: 'delete', path: '/messages/:id', tag: 'messages', summary: 'Delete a message (permanent; kept as a marker if it has replies)', action: 'message:delete', status: 204, kind: 'empty' }),
  uploadAttachment: r({ method: 'post', path: '/messages/:id/attachments', tag: 'messages', summary: 'Attach a file to a message', action: 'attachment:create', upload: true, status: 201, kind: 'json', response: S.AttachmentMeta }),
  deleteAttachment: r({ method: 'delete', path: '/attachments/:id', tag: 'messages', summary: 'Delete an attachment (permanent, audited)', action: 'attachment:delete', status: 204, kind: 'empty' }),
  downloadAttachment: r({ method: 'get', path: '/attachments/:id', tag: 'messages', summary: 'Download an attachment', action: 'attachment:read', status: 200, kind: 'binary' }),

  // ---- Notifications, activity ----
  notificationStream: r({ method: 'get', path: '/notifications/stream', tag: 'notifications', summary: 'Live "sync" pings (server-sent events)', status: 200, kind: 'sse' }),
  listNotifications: r({ method: 'get', path: '/notifications', tag: 'notifications', summary: 'Your notifications', query: listNotificationsQuerySchema, status: 200, kind: 'json', response: S.NotificationListResult }),
  markNotificationRead: r({ method: 'post', path: '/notifications/:id/read', tag: 'notifications', summary: 'Mark a notification read', status: 200, kind: 'json', response: z.object({ unreadCount: z.number().int() }).strict() }),
  markAllNotificationsRead: r({ method: 'post', path: '/notifications/read-all', tag: 'notifications', summary: 'Mark every notification read', status: 200, kind: 'json', response: z.object({ unreadCount: z.number().int() }).strict() }),
  listActivity: r({ method: 'get', path: '/activity', tag: 'activity', summary: 'The audit log', action: 'config:update', query: listActivityQuerySchema, status: 200, kind: 'json', response: S.ActivityListResult }),

  // ---- Integrations ----
  listIntegrations: r({ method: 'get', path: '/integrations', tag: 'integrations', summary: 'List integration connections', action: 'integration:create', query: includeRetired, status: 200, kind: 'json', response: z.array(S.IntegrationConnection) }),
  connectIntegration: r({ method: 'post', path: '/integrations', tag: 'integrations', summary: 'Connect a Discord server', action: 'integration:create', body: connectIntegrationSchema, status: 201, kind: 'json', response: S.IntegrationConnection }),
  updateIntegration: r({ method: 'patch', path: '/integrations/:id', tag: 'integrations', summary: 'Edit a connection', action: 'integration:update', body: updateIntegrationSchema, status: 200, kind: 'json', response: S.IntegrationConnection }),
  rotateIntegrationToken: r({ method: 'post', path: '/integrations/:id/rotate-token', tag: 'integrations', summary: "Replace a connection's bot token", action: 'integration:update', body: rotateTokenSchema, status: 200, kind: 'json', response: S.IntegrationConnection }),
  retireIntegration: r({ method: 'post', path: '/integrations/:id/retire', tag: 'integrations', summary: 'Retire a connection (sync pauses; `grants` applies at collection)', action: 'integration:retire', body: retireIntegrationSchema, status: 200, kind: 'json', response: S.IntegrationConnection }),
  reviveIntegration: r({ method: 'post', path: '/integrations/:id/revive', tag: 'integrations', summary: 'Revive a retired connection', action: 'integration:revive', status: 200, kind: 'json', response: S.IntegrationConnection }),
  listMappings: r({ method: 'get', path: '/integrations/:id/mappings', tag: 'integrations', summary: "A connection's group mappings", action: 'integration:update', status: 200, kind: 'json', response: z.array(S.ExternalGroupMapping) }),
  createMapping: r({ method: 'post', path: '/integrations/:id/mappings', tag: 'integrations', summary: 'Map a Discord role to a role, division or team', action: 'integration:update', body: createMappingSchema, status: 201, kind: 'json', response: S.ExternalGroupMapping }),
  updateMapping: r({ method: 'patch', path: '/integrations/:id/mappings/:mappingId', tag: 'integrations', summary: 'Edit a mapping', action: 'integration:update', body: updateMappingSchema, status: 200, kind: 'json', response: S.ExternalGroupMapping }),
  deleteMapping: r({ method: 'delete', path: '/integrations/:id/mappings/:mappingId', tag: 'integrations', summary: 'Delete a mapping, keeping or revoking what it granted', action: 'integration:update', query: deleteMappingSchema, status: 204, kind: 'empty' }),
  retryMapping: r({ method: 'post', path: '/integrations/:id/mappings/:mappingId/retry', tag: 'integrations', summary: 'Clear a broken mapping and resync', action: 'integration:update', status: 200, kind: 'json', response: S.ExternalGroupMapping }),
  triggerSync: r({ method: 'post', path: '/integrations/:id/sync', tag: 'integrations', summary: 'Queue a full sync', action: 'integration:update', status: 202, kind: 'json', response: S.SyncQueued }),

  // ---- Garbage collection ----
  gcSweep: r({ method: 'post', path: '/gc/sweep', tag: 'operations', summary: 'Collect retired data past its grace period', action: 'config:update', status: 200, kind: 'json', response: S.GcReport }),
  gcDryRun: r({ method: 'post', path: '/gc/sweep/dry-run', tag: 'operations', summary: 'Report what a sweep would collect', action: 'config:update', status: 200, kind: 'json', response: S.GcReport }),
} satisfies Record<string, ContractRoute>;

export type RouteId = keyof typeof ROUTES;
