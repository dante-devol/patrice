/**
 * The reconcile floor: the longest a connection goes without a full sync. Gateway
 * events trigger per-member syncs in between; the floor is the backstop. It is
 * measured on `last_sync_at` (problems D8), and the API reports `nextReconcileAt`
 * from this same value, so the admin UI keeps no copy of its own.
 */
export const RECONCILE_FLOOR_MS = 60 * 60 * 1000;

/** When the floor next guarantees a full sync: now, if the connection never synced. */
export function nextReconcileAt(lastSyncAt: Date | null, now = new Date()): Date {
  return lastSyncAt ? new Date(lastSyncAt.getTime() + RECONCILE_FLOOR_MS) : now;
}

/** Whether a connection is due for its floor sync. */
export function isFloorDue(lastSyncAt: Date | null, now = new Date()): boolean {
  return nextReconcileAt(lastSyncAt, now) <= now;
}
