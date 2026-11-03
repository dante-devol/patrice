/**
 * A task's status, derived from facts by one pure function, used on every path
 * (creation included). `status_cache` stores the result for filtering, and
 * {@link TaskStatusService.rebuild} can recompute it from the facts at any time.
 *
 * - A **completed** task is `approved`. Completion is terminal.
 * - Otherwise the status is the **lowest** contribution over the task's seats, in the
 *   order `open < claimed < revising < review < approved`:
 *   - an open seat (claims open, opening unfilled) contributes `open`;
 *   - a seated claimant who hasn't submitted contributes `claimed`;
 *   - a seated claimant's latest submission contributes its state;
 *   - rejected submissions and closed, unfilled seats contribute nothing.
 * - **Empty set floor:** when nothing contributes (say the only submission was
 *   rejected), the status is `claimed`, never a vacuous `approved`: the requester has
 *   to act.
 */
export type SubmissionState = 'review' | 'revising' | 'approved' | 'rejected' | 'not_required';
export type RolledStatus = 'open' | 'claimed' | 'review' | 'revising' | 'approved';

const STATUS_RANK: Readonly<Record<RolledStatus, number>> = {
  open: 0,
  claimed: 1,
  revising: 2,
  review: 3,
  approved: 4,
};

export interface StatusFacts {
  /** The task has been completed (`completed_at` is set). */
  completed: boolean;
  openings: number;
  claimsClosed: boolean;
  /**
   * One entry per seated claimant: the state of their latest live submission in their
   * current tenure of the seat, or `null` if they haven't submitted.
   */
  claimantStates: ReadonlyArray<SubmissionState | null>;
}

export function deriveStatus(facts: StatusFacts): RolledStatus {
  if (facts.completed) return 'approved';

  const contributions: RolledStatus[] = [];
  const openSeats = facts.claimsClosed ? 0 : Math.max(0, facts.openings - facts.claimantStates.length);
  for (let i = 0; i < openSeats; i++) contributions.push('open');

  for (const state of facts.claimantStates) {
    if (state === null) contributions.push('claimed');
    else if (state === 'rejected' || state === 'not_required') continue;
    else contributions.push(state);
  }

  if (contributions.length === 0) return 'claimed';
  return contributions.reduce((lowest, c) => (STATUS_RANK[c] < STATUS_RANK[lowest] ? c : lowest));
}
