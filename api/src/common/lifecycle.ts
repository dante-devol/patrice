/**
 * Shared lifecycle/state-machine helpers for the retire ↔ revive cycle
 * (api/CONTEXT.md "Retire"/"Grace Period"). Revive is only valid while the entity
 * is `retired` **and** still inside the configurable grace window; otherwise the
 * caller raises `409 NOT_REVIVABLE`. Centralised so every entity (role, division,
 * team, …) applies an identical predicate.
 */
export interface RevivableRow {
  lifecycleState: 'active' | 'deactivated' | 'retired';
  retiredAt: Date | null;
}

/** Whether a retired row is still within its grace window and may be revived. */
export function isRevivable(row: RevivableRow, graceDays: number): boolean {
  if (row.lifecycleState !== 'retired' || row.retiredAt == null) return false;
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  return Date.now() - row.retiredAt.getTime() <= graceMs;
}
