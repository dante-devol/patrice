import { Injectable, signal } from '@angular/core';

/**
 * Staged-but-unsaved edits that leaving should not silently drop. The admin tab on
 * screen reports its pending count and tells this service when a save lands; the admin
 * tabs and the `/admin` route ask before discarding, and the admin shell turns both into
 * the presence it announces to other admins.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedChangesService {
  readonly pending = signal(0);
  /** Bumps each time an editor saves, so the shell can announce `saved`. */
  readonly savedCount = signal(0);

  /** An editor's save landed: nothing is pending any more. */
  markSaved(): void {
    this.pending.set(0);
    this.savedCount.update((n) => n + 1);
  }

  /** True when it's fine to leave: nothing is pending, or the admin agrees to discard. */
  confirmLeave(): boolean {
    const n = this.pending();
    if (n === 0) return true;
    const ok = window.confirm(
      `You have ${n} unsaved ${n === 1 ? 'change' : 'changes'}. Discard ${n === 1 ? 'it' : 'them'}?`,
    );
    if (ok) this.pending.set(0);
    return ok;
  }
}
