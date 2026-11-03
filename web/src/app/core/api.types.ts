// API contract types. Everything the API sends or accepts is generated from the
// API's Zod contract (api/src/contract) via api/openapi.json → ./api/schema.d.ts.
// Regenerate with `npm run contract:emit` in api/ (or `npm run gen:api` here).
// The only hand-written types below are client-side conveniences (filters).

import type { components, operations } from './api/schema';

type Schemas = components['schemas'];
type JsonBody<Op extends keyof operations> = operations[Op] extends {
  requestBody?: { content: { 'application/json': infer B } };
}
  ? B
  : never;

export type Lifecycle = Schemas['Lifecycle'];
export type ScopeKind = Schemas['ScopeKind'];
export type AuthMethod = Schemas['AuthMethod'];
export type QuestionType = Schemas['QuestionType'];
export type TaskStatus = Schemas['TaskStatus'];
export type SubmissionState = Schemas['SubmissionState'];
export type MessageKind = Schemas['MessageKind'];
export type ActivitySource = Schemas['ActivitySource'];
export type IntegrationProvider = Schemas['IntegrationProvider'];
export type IntegrationStatus = Schemas['IntegrationStatus'];
export type SyncDirection = Schemas['SyncDirection'];
export type GatewayState = Schemas['GatewayState'];
export type SyncState = Schemas['SyncState'];
export type ErrorCode = Schemas['ErrorCode'];

export type ApiError = Schemas['ErrorBody'];
export type UserCapabilities = Schemas['UserCapabilities'];
export type CurrentUser = Schemas['CurrentUser'];
export type BootstrapStatus = Schemas['BootstrapStatus'];
export type InviteView = Schemas['InviteView'];
export type InvitationListItem = Schemas['InvitationListItem'];
export type CreatedInvitation = Schemas['CreatedInvitation'];
export type AdminUser = Schemas['AdminUser'];
export type OrgSettings = Schemas['OrgSettings'];
export type ConfigUpdate = JsonBody<'updateConfig'>;

export type Role = Schemas['Role'];
export type Division = Schemas['Division'];
export type Team = Schemas['Team'];
export type Grant = Schemas['Grant'];

export type ChoiceOption = Schemas['ChoiceOption'];
export type QuestionConstraints = Schemas['QuestionConstraints'];
export type Question = Schemas['Question'];
/** An authored question before it is saved (the server derives `ordinal`). The PUT
 *  body is stricter per type; the server validates the per-type constraint keys. */
export type QuestionInput = Pick<Question, 'type' | 'prompt' | 'required' | 'constraints'>;
export type RequestTemplate = Schemas['RequestTemplate'];

export type Task = Schemas['Task'];
export type TaskListResult = Schemas['TaskListResult'];
export type Attachment = Schemas['Attachment'];
export type AttachmentMeta = Schemas['AttachmentMeta'];
export type Message = Schemas['Message'];
export type MessageListResult = Schemas['MessageListResult'];

export type AnswerView = Schemas['Answer'];
export type Submission = Schemas['Submission'];
export type ReviewDecision = JsonBody<'reviewSubmission'>['decision'];
export type SubmitAnswer = JsonBody<'submit'>['answers'][number];

export type Notification = Schemas['Notification'];
export type NotificationListResult = Schemas['NotificationListResult'];
export type ActivityItem = Schemas['ActivityItem'];
export type ActivityListResult = Schemas['ActivityListResult'];

export type IntegrationConnection = Schemas['IntegrationConnection'];
export type ExternalGroupMapping = Schemas['ExternalGroupMapping'];

// ---- Client-side conveniences ------------------------------------------------

/** Typed facets for the task list; each may be a single value (multi-value via the
 *  `in:` API convention is not surfaced in the UI yet). */
export interface TaskFilters {
  division?: string;
  team?: string;
  status?: TaskStatus;
  requester?: string;
  claimant?: string;
}

/** Optional facets for the audit feed; all AND-composed server-side. */
export interface ActivityFilters {
  verb?: string;
  verbPrefix?: string;
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  source?: ActivitySource;
  from?: string;
  to?: string;
}
