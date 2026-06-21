import { Injectable } from '@nestjs/common';
import { PubSubPort, SyncEvent } from './pubsub.port';

/**
 * Single-instance {@link PubSubPort} adapter (Slice 6 v1). Keeps an in-memory map of
 * `userId → set of subscriber callbacks`; `publish` walks the user's set. Adequate
 * for v1's single-process topology — every SSE stream lives in this process, so an
 * in-memory map reaches them all. Multi-instance HA swaps this for a Postgres
 * `LISTEN/NOTIFY` adapter behind the same port.
 */
@Injectable()
export class InProcessPubSub implements PubSubPort {
  private readonly subscribers = new Map<string, Set<(ev: SyncEvent) => void>>();

  publish(userId: string, ev: SyncEvent): void {
    const set = this.subscribers.get(userId);
    if (!set) return;
    for (const cb of set) {
      // A throwing subscriber must not abort delivery to the others.
      try {
        cb(ev);
      } catch {
        /* swallow — a dead stream is reaped on its own close */
      }
    }
  }

  subscribe(userId: string, cb: (ev: SyncEvent) => void): () => void {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(cb);
    return () => {
      const current = this.subscribers.get(userId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.subscribers.delete(userId);
    };
  }
}
