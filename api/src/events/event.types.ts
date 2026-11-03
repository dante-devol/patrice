import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * The domain event catalog: every event the system records, with its typed payload.
 * Payloads carry ids, numbers and enums, never personal data; the one piece of
 * user-authored text is a submission-retire reason, which lives only here (not in
 * the audit log) so a moderator's note stays with the task it explains.
 *
 * Events with a task are that task's timeline. The client renders them from these
 * shapes (exported in the contract); nothing parses sentences.
 */
export const domainEventPayloadSchemas = {
  'task.created': z
    .object({ templateOrigin: z.enum(['library', 'custom']), sourceTemplateId: uuid.nullable() })
    .strict(),
  'task.claimed': z.object({ userId: uuid }).strict(),
  'task.left': z.object({ userId: uuid }).strict(),
  // The evictee's submissions from that seat, now treated as rejected.
  'task.claimant_evicted': z.object({ userId: uuid, submissionIds: z.array(uuid) }).strict(),
  'task.requester_changed': z.object({ fromUserId: uuid.optional(), toUserId: uuid }).strict(),
  'task.claims_changed': z
    .object({ openings: z.number().int().optional(), claimsClosed: z.boolean().optional() })
    .strict(),
  'task.completed': z.object({}).strict(),
  'task.retired': z.object({}).strict(),
  'task.revived': z.object({}).strict(),
  'submission.submitted': z.object({ submissionId: uuid, submissionNo: z.number().int() }).strict(),
  'submission.reviewed': z
    .object({
      submissionId: uuid,
      submissionNo: z.number().int(),
      decision: z.enum(['approve', 'return', 'reject']),
    })
    .strict(),
  'submission.retired': z
    .object({
      submissionId: uuid.optional(),
      submissionNo: z.number().int(),
      claimantUserId: uuid,
      reason: z.string(),
    })
    .strict(),
  // Not on the timeline (the comment is in the thread itself); here for notifications.
  'message.posted': z.object({ messageId: uuid, submissionId: uuid.optional() }).strict(),
  'message.replied': z.object({ messageId: uuid, parentMessageId: uuid }).strict(),
  'integration.push_failed': z.object({ connectionId: uuid, reason: z.string() }).strict(),
} as const;

export type DomainEventType = keyof typeof domainEventPayloadSchemas;
export type DomainEventPayload<T extends DomainEventType> = z.infer<(typeof domainEventPayloadSchemas)[T]>;

/** The event types that make up a task's timeline (the rest only notify). */
export const TIMELINE_EVENT_TYPES = [
  'task.created',
  'task.claimed',
  'task.left',
  'task.claimant_evicted',
  'task.requester_changed',
  'task.claims_changed',
  'task.completed',
  'task.retired',
  'task.revived',
  'submission.submitted',
  'submission.reviewed',
  'submission.retired',
] as const satisfies readonly DomainEventType[];
