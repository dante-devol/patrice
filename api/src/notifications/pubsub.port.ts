/**
 * The fan-out seam for live notification delivery. A domain event inserts
 * durable `notification` rows, then `publish(userId, ev)` pushes a thin **sync** ping
 * to that user's open SSE streams. The client reacts by pulling the durable rows —
 * **durability never rides the stream** (the ping carries no payload).
 *
 * v1 ships the in-process adapter ({@link InProcessPubSub}) for the single-instance
 * topology. The post-v1 multi-instance path is a Postgres `LISTEN/NOTIFY` adapter
 * behind this same port — swap the binding, no code-site changes.
 */
export const PUBSUB_PORT = Symbol('PUBSUB_PORT');

/** A content-free "go reconcile" nudge for the user's notifications. */
export interface SyncEvent {
  type: 'sync';
}

/** The admin pages whose editors announce that someone is changing them. */
export const ADMIN_PAGES = ['roles', 'divisions', 'teams', 'users', 'permissions', 'settings', 'integrations'] as const;
export type AdminPage = (typeof ADMIN_PAGES)[number];

/**
 * Another admin's editing state on an admin page: `editing` while they hold unsaved
 * changes (repeated as a heartbeat), `idle` when they discard or leave, `saved` after
 * a save. Ephemeral: never stored, and only sent to people allowed to view that page.
 */
export interface AdminPresenceEvent {
  type: 'admin-presence';
  page: AdminPage;
  userId: string;
  displayName: string;
  state: 'editing' | 'idle' | 'saved';
  at: string;
}

export type StreamEvent = SyncEvent | AdminPresenceEvent;

export interface PubSubPort {
  /** Push an event to every open subscription for `userId`. Fire-and-forget. */
  publish(userId: string, ev: StreamEvent): void;
  /**
   * Subscribe `cb` to `userId`'s events. Returns an unsubscribe function the caller
   * MUST invoke when the stream closes (else the subscription leaks).
   */
  subscribe(userId: string, cb: (ev: StreamEvent) => void): () => void;
  /** The users with at least one open stream (the audience for presence events). */
  subscribedUserIds(): string[];
}
