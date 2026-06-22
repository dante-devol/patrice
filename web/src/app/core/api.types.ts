// Hand-written API contract types for Slice 1.
//
// NOTE (deferred stack item): the pinned stack calls for an OpenAPI-generated
// client + TanStack Query. Slice 1 ships a slim hand-written data layer to stay
// runnable; wiring code-first OpenAPI emission (from the API's Zod schemas) and
// the generated client is a follow-up tracked against the Slice 1 umbrella.

export interface UserCapabilities {
  inviteCreate: boolean;
  manageOrg: boolean;
}

export type Lifecycle = 'active' | 'deactivated' | 'retired';

export interface Role {
  id: string;
  name: string;
  kind: 'standalone' | 'division' | 'team';
  divisionId: string | null;
  teamId: string | null;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  version: number;
}

export interface Division {
  id: string;
  name: string;
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  version: number;
  inherentRoleId: string;
}

export interface Team {
  id: string;
  name: string;
  restrictClaims: boolean;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  version: number;
  inherentRoleId: string;
}

export type ScopeKind =
  | 'global'
  | 'specific_division'
  | 'specific_team'
  | 'own_division'
  | 'own_team'
  | 'own'
  | 'role';

export interface Grant {
  id: string;
  roleId: string;
  action: string;
  effect: 'permit' | 'forbid';
  scopeKind: ScopeKind;
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  version: number;
}

export interface AdminUser {
  id: string;
  email: string | null;
  displayName: string;
  lifecycleState: Lifecycle;
  roleIds: string[];
}

export interface OrgSettings {
  requireVerifiedEmailToLogIn: boolean;
  selfReviewAllowed: boolean;
  anonymizeLabel: boolean;
  sessionAbsoluteDays: number;
  sessionIdleDays: number;
  /** Retire→revive grace window in hours (Slice 7.2); 0 disables the window. */
  gracePeriodHours: number;
  /** Slice 8: require Discord account link before task access. */
  requireDiscordLink: boolean;
}

export interface CurrentUser {
  id: string;
  organizationId: string;
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  hasDiscordLink: boolean;
  capabilities: UserCapabilities;
}

export interface BootstrapStatus {
  open: boolean;
  inviteToken: string | null;
}

export interface InviteView {
  // True when the invite is bound to a specific email. The value is intentionally
  // never sent — the redeemer must know it; the server enforces the match.
  requiresEmail: boolean;
  requiresPasscode: boolean;
  status: 'pending' | 'revoked' | 'exhausted' | 'expired';
  isBootstrap: boolean;
}

export interface InvitationListItem {
  id: string;
  email: string | null;
  intendedRoleIds: string[];
  maxUses: number;
  useCount: number;
  status: 'pending' | 'revoked' | 'exhausted' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface CreatedInvitation {
  id: string;
  token: string;
  url: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---- Slice 3: questionnaires --------------------------------------------

export type QuestionType =
  | 'detail_text'
  | 'multiline'
  | 'text'
  | 'numeric'
  | 'dropdown'
  | 'radio'
  | 'attachment';

export interface ChoiceOption {
  value: string;
  label: string;
}

/** Per-type constraint bag — only the keys relevant to a question's type are set. */
export interface QuestionConstraints {
  maxChars?: number;
  minChars?: number;
  kind?: 'integer' | 'float';
  min?: number;
  max?: number;
  multi?: boolean;
  options?: ChoiceOption[];
  minSelect?: number;
  maxSelect?: number;
  allowedTypes?: string[];
  maxBytes?: number;
  maxFiles?: number;
}

export interface Question {
  id?: string;
  ordinal?: number;
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: QuestionConstraints;
}

/** PUT body element — server derives `ordinal` from array order. */
export interface QuestionInput {
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: QuestionConstraints;
}

export interface Questionnaire {
  id: string;
  ownerDivisionId: string | null;
  ownerTaskId: string | null;
  questions: Question[];
}

// ---- Slice 4: tasks, messages, attachments ------------------------------

export type TaskStatus = 'open' | 'claimed' | 'review' | 'revising' | 'approved';

export interface Task {
  id: string;
  name: string;
  description: string;
  divisionId: string;
  teamId: string | null;
  requesterUserId: string;
  openings: number;
  claimsClosed: boolean;
  statusCache: TaskStatus | null;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListResult {
  items: Task[];
  nextCursor: string | null;
}

/** Typed facets for the task list; each may be a single value (multi-value via the
 *  `in:` API convention is not surfaced in the UI yet). */
export interface TaskFilters {
  division?: string;
  team?: string;
  status?: TaskStatus;
  requester?: string;
  claimant?: string;
}

export interface Attachment {
  id: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  byteSize: number;
  kind: string;
  uploaderUserId: string;
  createdAt: string;
}

export type MessageKind = 'comment' | 'system';

export interface Message {
  id: string;
  taskId: string;
  kind: MessageKind;
  senderUserId: string | null;
  parentMessageId: string | null;
  body: string;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  editedAt: string | null;
  version: number;
  createdAt: string;
  attachments: Attachment[];
  replies?: Message[];
}

export interface MessageListResult {
  items: Message[];
  nextCursor: string | null;
}

// ---- Slice 5: submissions & review lifecycle ----------------------------

export type SubmissionState = 'review' | 'revising' | 'approved' | 'rejected';

export interface AnswerView {
  id: string;
  questionId: string;
  value: unknown;
  attachmentIds: string[];
}

export interface Submission {
  id: string;
  taskId: string;
  claimantUserId: string;
  submissionNo: number;
  prevSubmissionId: string | null;
  state: SubmissionState;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lifecycleState: Lifecycle;
  version: number;
  answers: AnswerView[];
}

export type ReviewDecision = 'approve' | 'return' | 'reject';

/** One submitted answer in a `task:submit` payload. */
export interface SubmitAnswer {
  questionId: string;
  value?: string | number | string[] | null;
  attachmentIds?: string[];
}

// ---- Slice 6: notifications ---------------------------------------------

export interface Notification {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  /** IDs + small enums only (no PII) — render names by joining via LookupStore. */
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationListResult {
  items: Notification[];
  unreadCount: number;
  nextCursor: string | null;
}

// ---- Slice 8: integrations ----------------------------------------------

export type IntegrationProvider = 'discord';
export type IntegrationStatus = 'active' | 'broken' | 'disabled';
export type SyncDirection = 'inbound' | 'outbound' | 'bidirectional';

export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  externalWorkspaceId: string;
  displayName: string;
  config: Record<string, unknown>;
  credentialsRef: string | null;
  status: IntegrationStatus;
  lifecycleState: Lifecycle;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalGroupMapping {
  id: string;
  roleId: string;
  connectionId: string;
  externalGroupId: string;
  syncDirection: SyncDirection;
  isBroken: boolean;
  createdAt: string;
  updatedAt: string;
}
