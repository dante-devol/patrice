import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AdminApi } from './api/org.api';
import { AdminPage, AdminPresence } from './api.types';

/** How long an `editing` report counts without a heartbeat (the editor repeats it every 20s). */
export const EDITING_TTL_MS = 60_000;
/** How long a `saved` report stays up if it isn't dismissed. */
export const SAVED_TTL_MS = 10 * 60_000;
/** How often an editor with unsaved changes repeats `editing`. */
export const HEARTBEAT_MS = 20_000;

export interface PresenceEntry extends AdminPresence {
  receivedAt: number;
}

/**
 * Who else is changing an admin page. The notification stream delivers other admins'
 * `admin-presence` events (the API sends them only to people allowed to see the page);
 * this store keeps the latest per page and person, and ages them out so a closed tab
 * or a dropped connection doesn't leave a stale warning behind.
 */
@Injectable({ providedIn: 'root' })
export class AdminPresenceStore {
  private readonly adminApi = inject(AdminApi);
  private readonly entries = signal<PresenceEntry[]>([]);
  /** Ticks so that entries age out while nothing else changes. */
  private readonly now = signal(Date.now());

  constructor() {
    if (typeof window !== 'undefined') setInterval(() => this.now.set(Date.now()), 5_000);
  }

  /** An event from the stream. `idle` clears that person's entry for the page. */
  receive(ev: AdminPresence): void {
    const rest = this.entries().filter((e) => !(e.page === ev.page && e.userId === ev.userId));
    this.entries.set(ev.state === 'idle' ? rest : [...rest, { ...ev, receivedAt: Date.now() }]);
  }

  /** The other admins currently editing, or who recently saved, on `page`. */
  readonly forPage = computed(() => {
    const now = this.now();
    const live = this.entries().filter(
      (e) => now - e.receivedAt < (e.state === 'editing' ? EDITING_TTL_MS : SAVED_TTL_MS),
    );
    return (page: AdminPage) => ({
      editing: live.filter((e) => e.page === page && e.state === 'editing'),
      saved: live.filter((e) => e.page === page && e.state === 'saved'),
    });
  });

  /** Forget the `saved` notices on a page (after a reload, or when dismissed). */
  clearSaved(page: AdminPage): void {
    this.entries.update((es) => es.filter((e) => !(e.page === page && e.state === 'saved')));
  }

  /** Tell the other admins about this editor's state. Best effort: a failure is silent. */
  async report(page: AdminPage, state: AdminPresence['state']): Promise<void> {
    try {
      await firstValueFrom(this.adminApi.announcePresence(page, state));
    } catch {
      // Presence is a courtesy; a dropped report must never block editing.
    }
  }
}
