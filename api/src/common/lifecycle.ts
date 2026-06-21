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

/**
 * Whether a retired row is still within its grace window and may be revived.
 * `graceMs` is the window in milliseconds (resolved per-org from
 * `organization.settings.gracePeriodHours`; see {@link GraceService}).
 */
export function isRevivable(row: RevivableRow, graceMs: number): boolean {
  if (row.lifecycleState !== 'retired' || row.retiredAt == null) return false;
  return Date.now() - row.retiredAt.getTime() <= graceMs;
}

/**
 * The soft-retire default list filter (Slice 7.2): list queries exclude retired
 * rows unless retired rows are explicitly opted in (`?include=retired`). Deactivated
 * rows stay visible — the filter targets *retired* only, so deactivated users remain
 * listable for reactivation. Returns a partial Prisma `where` fragment.
 */
export function activeFilter(
  includeRetired?: boolean,
): { lifecycleState?: { not: 'retired' } } {
  return includeRetired ? {} : { lifecycleState: { not: 'retired' } };
}
