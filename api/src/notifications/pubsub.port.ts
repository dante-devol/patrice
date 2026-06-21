/**
 * The fan-out seam for live notification delivery (Slice 6). A domain event inserts
 * durable `notification` rows, then `publish(userId, ev)` pushes a thin **sync** ping
 * to that user's open SSE streams. The client reacts by pulling the durable rows —
 * **durability never rides the stream** (the ping carries no payload).
 *
 * v1 ships the in-process adapter ({@link InProcessPubSub}) for the single-instance
 * topology. The post-v1 multi-instance path is a Postgres `LISTEN/NOTIFY` adapter
 * behind this same port — swap the binding, no code-site changes.
 */
export const PUBSUB_PORT = Symbol('PUBSUB_PORT');

/** The only event v1 fans out: a content-free "go reconcile" nudge. */
export interface SyncEvent {
  type: 'sync';
}

export interface PubSubPort {
  /** Push an event to every open subscription for `userId`. Fire-and-forget. */
  publish(userId: string, ev: SyncEvent): void;
  /**
   * Subscribe `cb` to `userId`'s events. Returns an unsubscribe function the caller
   * MUST invoke when the stream closes (else the subscription leaks).
   */
  subscribe(userId: string, cb: (ev: SyncEvent) => void): () => void;
}
