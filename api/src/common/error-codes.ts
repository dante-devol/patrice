/**
 * The catalog of every error code the API returns, with its HTTP status. Error
 * classes accept only codes whose status matches their own (see errors.ts), so a code
 * can't drift between statuses. The catalog is exported in the OpenAPI contract so the
 * client can switch on codes without guessing.
 */
export const ERROR_CODES = {
  // 401
  UNAUTHENTICATED: { status: 401, description: 'No valid session' },
  INVALID_CREDENTIALS: { status: 401, description: 'Email or password is wrong' },
  DISCORD_NO_ACCOUNT: { status: 401, description: 'No Patrice account is linked to this Discord account' },

  // 403
  FORBIDDEN: { status: 403, description: 'The access engine denied the action' },
  CSRF_FAILED: { status: 403, description: 'Missing or invalid CSRF token' },
  EMAIL_NOT_VERIFIED: { status: 403, description: 'Login requires a verified email address' },
  INVALID_PASSCODE: { status: 403, description: 'The invitation passcode is wrong' },
  EMAIL_MISMATCH: { status: 403, description: 'The email does not match the invitation' },
  ROLE_NOT_GRANTABLE: { status: 403, description: 'The inviter may not grant this role' },

  // 404
  NOT_FOUND: { status: 404, description: 'Not found' },
  RECORD_NOT_FOUND: { status: 404, description: 'The record was removed while the request ran' },
  ASSIGNMENT_NOT_FOUND: { status: 404, description: 'Unit role assignment not found' },
  ATTACHMENT_NOT_FOUND: { status: 404, description: 'Attachment not found' },
  CLAIMANT_NOT_FOUND: { status: 404, description: 'That user does not hold a seat on this task' },
  CONNECTION_NOT_FOUND: { status: 404, description: 'Integration connection not found' },
  DIVISION_NOT_FOUND: { status: 404, description: 'Division not found' },
  GRANT_NOT_FOUND: { status: 404, description: 'Grant not found' },
  INVITE_NOT_FOUND: { status: 404, description: 'Invitation not found' },
  MAPPING_NOT_FOUND: { status: 404, description: 'Group mapping not found' },
  MESSAGE_NOT_FOUND: { status: 404, description: 'Message not found' },
  PARENT_NOT_FOUND: { status: 404, description: 'The parent message was not found' },
  REQUEST_TEMPLATE_NOT_FOUND: { status: 404, description: 'Request template not found' },
  ROLE_NOT_FOUND: { status: 404, description: 'Role not found' },
  SESSION_NOT_FOUND: { status: 404, description: 'Session not found' },
  SUBMISSION_NOT_FOUND: { status: 404, description: 'Submission not found' },
  TASK_NOT_FOUND: { status: 404, description: 'Task not found' },
  TEAM_NOT_FOUND: { status: 404, description: 'Team not found' },
  USER_NOT_FOUND: { status: 404, description: 'User not found' },

  // 409
  CONFLICT: { status: 409, description: 'Conflict' },
  ALREADY_EXISTS: { status: 409, description: 'That value is already in use' },
  REFERENCE_CONFLICT: { status: 409, description: 'Another record still references this one, or a referenced record is gone' },
  STALE_GRANT: { status: 409, description: 'Someone else changed these permissions; reload' },
  STALE_MEMBERSHIP: { status: 409, description: 'Someone else changed these memberships; reload' },
  STALE_VERSION: { status: 409, description: 'The record changed since it was read; reload and retry' },
  ALREADY_CLAIMED: { status: 409, description: 'You already hold a seat on this task' },
  ALREADY_RETIRED: { status: 409, description: 'Already retired' },
  ALREADY_SUBMITTED: { status: 409, description: 'A submission is already awaiting review' },
  CLAIMS_CLOSED: { status: 409, description: 'The task is not accepting claims' },
  DISCORD_ALREADY_LINKED: { status: 409, description: 'This Discord account belongs to another user' },
  IDENTITY_TAKEN: { status: 409, description: 'That sign-in account already belongs to another user' },
  PROVIDER_ALREADY_CONNECTED: { status: 409, description: 'A different account from this provider is already connected' },
  DIVISION_RETIRED: { status: 409, description: 'Division is retired' },
  DIVISION_SOLE_TEAM_DIVISION: {
    status: 409,
    description: 'Retiring the division would leave an active team with no active division (details.teams names them)',
  },
  DUPLICATE_CONNECTION: { status: 409, description: 'That workspace is already connected' },
  DUPLICATE_MAPPING: { status: 409, description: 'That mapping already exists' },
  EMAIL_TAKEN: { status: 409, description: 'That email address is already in use' },
  INVALID_OPENINGS: { status: 409, description: 'Openings cannot go below the active claimant count' },
  INVALID_TRANSITION: { status: 409, description: 'The submission is not in a state that allows this' },
  INVITE_RACE_LOST: { status: 409, description: 'The invitation was used concurrently' },
  LAST_ADMIN: { status: 409, description: 'Refused: this would remove the last administrator' },
  LAST_AUTH_METHOD: { status: 409, description: 'Refused: this would remove your only sign-in method' },
  MESSAGE_RETIRED: { status: 409, description: 'Message is retired' },
  NOT_A_MEMBER: { status: 409, description: 'The user does not hold that role' },
  NOT_CLAIMED: { status: 409, description: 'You do not hold a seat on this task' },
  NOT_REVIVABLE: { status: 409, description: 'Not retired, or past the grace period' },
  NO_OPENINGS: { status: 409, description: 'Every seat on the task is taken' },
  OPENINGS_LOCKED: { status: 409, description: 'Openings are locked for this division' },
  REQUEST_TEMPLATE_LOCKED: { status: 409, description: 'The request template is locked by a submission' },
  TEMPLATE_NAME_TAKEN: { status: 409, description: 'The division already has a template with that name' },
  QUESTION_HAS_ANSWERS: { status: 409, description: 'A question with answers cannot be deleted' },
  SUBMITTED_CANNOT_LEAVE: { status: 409, description: 'You cannot leave after submitting; the requester can retire your submission' },
  TASK_COMPLETED: { status: 409, description: 'The task is complete' },
  ALREADY_COMPLETED: { status: 409, description: 'The task is already complete' },
  STALE_SUBMISSION: { status: 409, description: 'The submission changed since it was read' },
  SUBMISSION_RETIRED: { status: 409, description: 'Submission is retired' },
  TASK_RETIRED: { status: 409, description: 'Task is retired' },
  TEAM_RETIRED: { status: 409, description: 'Team is retired' },
  TEAM_DIVISION_IN_USE: {
    status: 409,
    description: "The team has tasks in a division it would no longer support (details.divisions counts them)",
  },
  USER_RETIRED: { status: 409, description: 'User is retired' },

  // 410
  GONE: { status: 410, description: 'No longer available' },
  INVITE_UNAVAILABLE: { status: 410, description: 'The invitation is expired, revoked or used up' },
  TOKEN_INVALID: { status: 410, description: 'The link is invalid, expired or already used' },

  // 422
  VALIDATION_FAILED: { status: 422, description: 'The request body or parameters failed validation' },
  UNPROCESSABLE: { status: 422, description: 'Unprocessable entity' },
  DISCORD_NOT_CONFIGURED: { status: 422, description: 'Discord sign-in is not configured' },
  FILE_TOO_LARGE: { status: 422, description: 'The upload exceeds the size limit' },
  INVALID_SUBMISSION: { status: 422, description: 'The answers do not satisfy the request template' },
  TEMPLATE_REQUIRED: { status: 422, description: 'The division has no default template; pick one' },
  TEMPLATE_NOT_IN_DIVISION: { status: 422, description: 'The template belongs to a different division' },
  UNKNOWN_QUESTION_ID: { status: 422, description: 'A question id does not belong to this template' },
  GOVERNANCE_ROLE_NOT_MAPPABLE: { status: 422, description: 'A role holding governance grants cannot be mapped to an external group' },
  GOVERNANCE_ROLE_MAPPED: { status: 422, description: 'A role an integration grants cannot hold governance actions' },
  NO_FILE: { status: 422, description: 'No file was uploaded' },
  TEAM_NOT_IN_DIVISION: { status: 422, description: "The team doesn't support the task's division" },
  NOT_LINKED: { status: 422, description: 'The account is not linked' },
  REPLY_TO_REPLY: { status: 422, description: 'Threads are one level deep' },
  ROLE_RETIRED: { status: 422, description: 'Role is retired' },
  NOT_A_UNIT_ROLE: { status: 422, description: 'That role is not a unit role' },
  UNIT_ROLE_NOT_GRANTABLE: { status: 422, description: 'A unit role is assigned at a division or team, not held org-wide' },
  UNIT_ROLE_SCOPE: {
    status: 422,
    description: "A unit role takes only unit actions, where it's held or on your own things there; org roles can't use the assigned scope",
  },
  BASELINE_ROLE: {
    status: 409,
    description: 'Everyone is held by every user: it is never given, taken away, mapped, renamed, retired or targeted by a grant',
  },
  NOT_A_DEFAULT_ROLE: { status: 422, description: "A unit's default role must be an active unit role" },
  WRONG_PASSWORD: { status: 422, description: 'The current password is wrong' },

  // 429
  TOO_MANY_REQUESTS: { status: 429, description: 'Rate limit exceeded' },

  // 500 / 503
  INTERNAL: { status: 500, description: 'Internal server error' },
  ERROR: { status: 500, description: 'Unclassified error' },
  QUEUE_UNAVAILABLE: { status: 503, description: 'Background jobs are unavailable; try again later' },
} as const satisfies Record<string, { status: number; description: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The codes that carry HTTP status `S`. */
export type CodeWithStatus<S extends number> = {
  [K in ErrorCode]: (typeof ERROR_CODES)[K]['status'] extends S ? K : never;
}[ErrorCode];

/** The fallback code for a bare HTTP status (Nest built-ins, unexpected throws). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 410:
      return 'GONE';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'ERROR';
  }
}
