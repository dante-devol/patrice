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
