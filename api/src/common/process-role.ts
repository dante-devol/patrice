/**
 * Process topology split (#60 / ADR 0003).
 *
 * PROCESS_ROLE unset (dev/test) → combined process (both api + worker behaviors).
 * PROCESS_ROLE=api  → HTTP only, no background starters.
 * PROCESS_ROLE=worker → no HTTP, pg-boss consumers + cron + GC + Gateway.
 */

export type ProcessRoleValue = 'api' | 'worker' | 'combined';

/** True when this process should run HTTP. */
export function isApiRole(role: ProcessRoleValue): boolean {
  return role === 'api' || role === 'combined';
}

/** True when this process should run background consumers, cron, GC, and Gateway. */
export function isWorkerRole(role: ProcessRoleValue): boolean {
  return role === 'worker' || role === 'combined';
}

export const PROCESS_ROLE = Symbol('PROCESS_ROLE');
