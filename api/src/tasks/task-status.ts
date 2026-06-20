/**
 * Status-cache computation (Slice 4 subset). The full Status Min-Rule over counted
 * submission slots lands in Slice 5; here a task is only ever **open** or **claimed**:
 *
 *   - `open`    — claims are not closed AND there is at least one free opening.
 *   - `claimed` — every opening is filled, or the requester has closed claims.
 *
 * Kept pure (no Prisma) so the rule is unit-testable in isolation and reused by the
 * claim/leave/manage-claims flows (Slice 4.2) that recompute it.
 */
export type Slice4Status = 'open' | 'claimed';

export interface StatusInputs {
  /** Active (not-left) claimant count. */
  activeClaimants: number;
  /** The task's opening count. */
  openings: number;
  /** Whether the requester has closed the task to new claims. */
  claimsClosed: boolean;
}

export function computeStatusCache(inputs: StatusInputs): Slice4Status {
  const hasFreeOpening =
    !inputs.claimsClosed && inputs.activeClaimants < inputs.openings;
  return hasFreeOpening ? 'open' : 'claimed';
}

/**
 * The full Status Min-Rule (Slice 5). A task's `status_cache` is the **lowest** status
 * over its *contributing* claimant slots, ordered `open < claimed < revising < review
 * < approved`. Each slot contributes:
 *
 *   - an **open spot** (claims open, opening unfilled) ⇒ `open`;
 *   - a **claimed, unsubmitted** slot ⇒ `claimed`;
 *   - a **submitted** slot ⇒ that submission's state (`review`/`revising`/`approved`);
 *   - **rejected** submissions and **closed-unfilled** spots are **excluded**.
 *
 * **Empty Contributing Set Floor:** if nothing contributes (e.g. the only submission
 * was rejected, or all spots are rejected/closed-unfilled), the result is `claimed`,
 * never a vacuous `approved` — the requester must act. A task is `approved` only when
 * every counted slot is `approved` AND at least one Approved slot exists, which the
 * min over a non-empty contributing set yields for free.
 *
 * Kept pure (no Prisma) so the rule is unit-testable; the DB-backed recompute that
 * feeds it lives in {@link TaskStatusService}.
 */
export type SubmissionState = 'review' | 'revising' | 'approved' | 'rejected';
export type RolledStatus = 'open' | 'claimed' | 'review' | 'revising' | 'approved';

const STATUS_RANK: Readonly<Record<RolledStatus, number>> = {
  open: 0,
  claimed: 1,
  revising: 2,
  review: 3,
  approved: 4,
};

export interface MinRuleInputs {
  /** The task's opening count. */
  openings: number;
  /** Whether the requester has closed the task to new claims. */
  claimsClosed: boolean;
  /**
   * One entry per ACTIVE (not-left) claimant slot: that claimant's latest non-retired
   * submission state, or `null` if they hold the slot but haven't submitted.
   */
  claimantStates: ReadonlyArray<SubmissionState | null>;
}

export function computeMinRuleStatus(inputs: MinRuleInputs): RolledStatus {
  const contributions: RolledStatus[] = [];

  const openSpots = inputs.claimsClosed
    ? 0
    : Math.max(0, inputs.openings - inputs.claimantStates.length);
  for (let i = 0; i < openSpots; i++) contributions.push('open');

  for (const state of inputs.claimantStates) {
    if (state === null) contributions.push('claimed');
    else if (state === 'rejected') continue; // excluded from the min
    else contributions.push(state);
  }

  // Empty Contributing Set Floor — never vacuously Approved.
  if (contributions.length === 0) return 'claimed';

  return contributions.reduce((lowest, c) =>
    STATUS_RANK[c] < STATUS_RANK[lowest] ? c : lowest,
  );
}
