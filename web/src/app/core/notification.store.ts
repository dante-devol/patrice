import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ApiService } from './api.service';
import { AuthStore } from './auth.store';
import { Notification } from './api.types';

/**
 * Live notifications (Slice 6 web). An `EventSource` on `/api/notifications/stream`
 * carries content-free **sync** pings; on each ping (and on connect/reconnect) the
 * store **reconciles** by pulling the durable rows from `GET /notifications` — the
 * stream never carries payloads, so the table is always the source of truth. Exposes
 * the `feed` and a computed `unreadCount` for the header badge.
 *
 * Lifecycle is bound to auth: the stream opens when a user is present and closes on
 * logout (an effect watching {@link AuthStore.isAuthenticated}).
 */
@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthStore);

  private readonly _feed = signal<Notification[]>([]);
  private readonly _unreadCount = signal(0);
  private source: EventSource | null = null;

  readonly feed = this._feed.asReadonly();
  readonly unreadCount = this._unreadCount.asReadonly();
  readonly hasUnread = computed(() => this._unreadCount() > 0);

  constructor() {
    // Open/close the stream as authentication comes and goes.
    effect(() => {
      if (this.auth.isAuthenticated()) {
        this.connect();
      } else {
        this.disconnect();
      }
    });
  }

  /** Open the SSE stream (idempotent). Reconciles on connect and on every ping. */
  private connect(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    const es = new EventSource(this.api.notificationStreamUrl, {
      withCredentials: true,
    });
    // The server names new-notification events `sync`; on connect it sends one
    // immediately, and EventSource auto-reconnects (each reconnect re-syncs). The
    // periodic `ping` keepalive is intentionally ignored.
    es.addEventListener('sync', () => void this.reconcile());
    this.source = es;
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
    this._feed.set([]);
    this._unreadCount.set(0);
  }

  /** Pull the durable rows + unread count. Safe to call repeatedly. */
  async reconcile(): Promise<void> {
    try {
      const res = await this.api.listNotifications({ limit: 50 });
      this._feed.set(res.items);
      this._unreadCount.set(res.unreadCount);
    } catch {
      // A transient pull failure leaves the last-known state; the next ping retries.
    }
  }

  async markRead(id: string): Promise<void> {
    const res = await this.api.markNotificationRead(id);
    this._unreadCount.set(res.unreadCount);
    this._feed.update((items) =>
      items.map((n) =>
        n.id === id && n.readAt === null
          ? { ...n, readAt: new Date().toISOString() }
          : n,
      ),
    );
  }

  async markAllRead(): Promise<void> {
    const res = await this.api.markAllNotificationsRead();
    this._unreadCount.set(res.unreadCount);
    const now = new Date().toISOString();
    this._feed.update((items) =>
      items.map((n) => (n.readAt === null ? { ...n, readAt: now } : n)),
    );
  }
}
