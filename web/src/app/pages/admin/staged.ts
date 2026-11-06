import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage } from '../../core/errors';

/**
 * One staged admin change, applied on Save. `run` calls the API; `clear` drops the
 * change from the editor's staging once it has landed, so a save that stops halfway
 * leaves exactly the changes that didn't apply.
 */
export interface StagedOp {
  run: () => Promise<unknown>;
  clear: () => void;
}

export interface StagedResult {
  done: number;
  total: number;
  /** The first failure; the ops after it were not attempted. */
  error: unknown;
}

/**
 * Apply staged ops in order, stopping at the first failure. Tabs whose API has no batch
 * endpoint save this way: each change is still version-checked by the server, and a
 * failure reports how many landed rather than pretending nothing did.
 */
export async function runStaged(ops: StagedOp[]): Promise<StagedResult> {
  let done = 0;
  for (const op of ops) {
    try {
      await op.run();
    } catch (error) {
      return { done, total: ops.length, error };
    }
    op.clear();
    done++;
  }
  return { done, total: ops.length, error: null };
}

/** A 409 meaning someone else changed the data since it was read (offer Reload). */
export function isStale(e: unknown): boolean {
  const code = e instanceof HttpErrorResponse ? (e.error as { error?: { code?: string } })?.error?.code : undefined;
  return e instanceof HttpErrorResponse && e.status === 409 && !!code && code.startsWith('STALE_');
}

/** The message for a failed save, saying how much of it landed. */
export function stagedErrorMessage(r: StagedResult): string {
  const why = errorMessage(r.error);
  return r.done === 0 ? why : `Saved ${r.done} of ${r.total} changes, then stopped: ${why}`;
}
