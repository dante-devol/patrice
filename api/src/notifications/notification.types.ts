/**
 * Notification verb catalog + the recipient matrix .
 *
 * `type` is the fixed v1 enumeration. It is stored as free text (no DB enum) so the
 * set can grow without a migration, but the closed union below is the source of truth
 * the service emits against.
 *
 * Recipient resolution is computed **at event time** and snapshotted; the sender is
 * universally suppressed from their own recipient set (see {@link computeRecipients}).
 * The matrix table is mirrored here as documentation — the per-call-site resolvers in
 * NotificationsService encode it against live data.
 */
export const NOTIFICATION_TYPES = [
  'task.submitted',
  'task.reviewed_approved',
  'task.reviewed_returned',
  'task.reviewed_rejected',
  'task.completed',
  'task.requester_changed',
  'task.claim_joined',
  'task.claim_left',
  'task.claim_evicted',
  'task.claims_closed',
  'task.retired',
  'message.posted',
  'message.replied',
  'message.submission_thread_replied',
  // Admin alert: an outbound Discord role push was refused (e.g. bot permissions).
  'integration.push_failed',
  // You were given a unit role at a division or team.
  'unit_role.assigned',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Review decision → the notification type it raises for the claimant. */
export const REVIEW_DECISION_TYPE: Readonly<
  Record<'approve' | 'return' | 'reject', NotificationType>
> = {
  approve: 'task.reviewed_approved',
  return: 'task.reviewed_returned',
  reject: 'task.reviewed_rejected',
};

/**
 * The recipient set actually written: de-duplicated, the sender removed, falsy ids
 * dropped. Pure (no I/O) so the suppression + dedupe contract is unit-testable.
 */
export function computeRecipients(
  recipientUserIds: readonly (string | null | undefined)[],
  senderUserId?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of recipientUserIds) {
    if (!id) continue;
    if (senderUserId && id === senderUserId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
