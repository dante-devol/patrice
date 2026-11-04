import { Injectable, signal } from '@angular/core';

/**
 * Staged-but-unsaved edits that leaving should not silently drop. An editor reports
 * its pending count; the admin tabs and the `/admin` route ask before discarding.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedChangesService {
  readonly pending = signal(0);

  /** True when it's fine to leave: nothing is pending, or the admin agrees to discard. */
  confirmLeave(): boolean {
    const n = this.pending();
    if (n === 0) return true;
    const ok = window.confirm(
      `You have ${n} unsaved permission ${n === 1 ? 'change' : 'changes'}. Discard ${n === 1 ? 'it' : 'them'}?`,
    );
    if (ok) this.pending.set(0);
    return ok;
  }
}
