/**
 * Discord Gateway connection state machine (#61).
 *
 * Pure (no I/O) — all side effects are described as events the caller must act on.
 * This makes it unit-testable without a live WebSocket.
 *
 * States:
 *  disconnected → connecting → identifying → ready → resuming
 *  Any state → disconnected on error/close.
 *
 * The caller drives the machine by calling handle(event) and then processing
 * the returned Actions.
 */

export type GatewayState =
  | 'disconnected'
  | 'connecting'
  | 'identifying'
  | 'ready'
  | 'resuming';

export interface GatewayContext {
  state: GatewayState;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  sequenceNumber: number | null;
  heartbeatInterval: number | null;
  missedHeartbeats: number;
  reconnectAttempt: number;
  isNewSession: boolean; // true after IDENTIFY (not RESUME)
}

// Events the socket / caller feeds in.
export type GatewayEvent =
  | { type: 'OPEN' }
  | { type: 'HELLO'; heartbeatInterval: number }
  | { type: 'READY'; sessionId: string; resumeGatewayUrl: string }
  | { type: 'RESUMED' }
  | { type: 'HEARTBEAT_ACK' }
  | { type: 'HEARTBEAT_MISSED' }
  | { type: 'CLOSE'; code: number }
  | { type: 'DISPATCH'; seq: number; eventName: string; data: unknown }
  | { type: 'INVALID_SESSION'; resumable: boolean };

// Actions the caller must execute.
export type GatewayAction =
  | { type: 'SEND_IDENTIFY'; token: string }
  | { type: 'SEND_RESUME'; token: string; sessionId: string; seq: number }
  | { type: 'SEND_HEARTBEAT'; seq: number | null }
  | { type: 'START_HEARTBEAT'; intervalMs: number }
  | { type: 'SCHEDULE_RECONNECT'; delayMs: number }
  | { type: 'EMIT_MEMBER_EVENT'; eventName: string; data: unknown }
  | { type: 'TRIGGER_RECONCILE' }
  | { type: 'EMIT_HEALTH'; healthy: boolean };

// Discord WebSocket close codes that are non-resumable.
const NON_RESUMABLE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

const MEMBER_EVENTS = new Set([
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
]);

export function initialContext(): GatewayContext {
  return {
    state: 'disconnected',
    sessionId: null,
    resumeGatewayUrl: null,
    sequenceNumber: null,
    heartbeatInterval: null,
    missedHeartbeats: 0,
    reconnectAttempt: 0,
    isNewSession: false,
  };
}

/**
 * Process one event and return the next context + actions to perform.
 * The caller is responsible for executing every action returned.
 */
export function handle(
  ctx: GatewayContext,
  event: GatewayEvent,
  token: string,
): { context: GatewayContext; actions: GatewayAction[] } {
  const next = { ...ctx };
  const actions: GatewayAction[] = [];

  switch (event.type) {
    case 'OPEN':
      next.state = 'connecting';
      // HELLO arrives next; nothing to send until then.
      break;

    case 'HELLO':
      next.heartbeatInterval = event.heartbeatInterval;
      actions.push({ type: 'START_HEARTBEAT', intervalMs: event.heartbeatInterval });
      actions.push({ type: 'SEND_HEARTBEAT', seq: next.sequenceNumber });
      if (ctx.sessionId && ctx.sequenceNumber !== null && !NON_RESUMABLE_CODES.has(0)) {
        next.state = 'resuming';
        next.isNewSession = false;
        actions.push({ type: 'SEND_RESUME', token, sessionId: ctx.sessionId, seq: ctx.sequenceNumber });
      } else {
        next.state = 'identifying';
        next.isNewSession = true;
        actions.push({ type: 'SEND_IDENTIFY', token });
      }
      break;

    case 'READY':
      next.state = 'ready';
      next.sessionId = event.sessionId;
      next.resumeGatewayUrl = event.resumeGatewayUrl;
      next.reconnectAttempt = 0;
      next.isNewSession = true;
      // New session: trigger full reconcile to cover the session gap.
      actions.push({ type: 'TRIGGER_RECONCILE' });
      actions.push({ type: 'EMIT_HEALTH', healthy: true });
      break;

    case 'RESUMED':
      next.state = 'ready';
      next.reconnectAttempt = 0;
      next.isNewSession = false;
      // Clean RESUME: events replayed, no gap — do NOT trigger reconcile.
      actions.push({ type: 'EMIT_HEALTH', healthy: true });
      break;

    case 'HEARTBEAT_ACK':
      next.missedHeartbeats = 0;
      break;

    case 'HEARTBEAT_MISSED':
      next.missedHeartbeats += 1;
      if (next.missedHeartbeats >= 3) {
        // Zombie connection — force close and reconnect.
        next.state = 'disconnected';
        next.missedHeartbeats = 0;
        const delay = reconnectDelay(next.reconnectAttempt++);
        actions.push({ type: 'SCHEDULE_RECONNECT', delayMs: delay });
        actions.push({ type: 'EMIT_HEALTH', healthy: false });
      }
      break;

    case 'CLOSE': {
      const canResume = !NON_RESUMABLE_CODES.has(event.code);
      if (!canResume) {
        next.sessionId = null;
        next.sequenceNumber = null;
      }
      next.state = 'disconnected';
      next.missedHeartbeats = 0;
      const delay = reconnectDelay(next.reconnectAttempt++);
      actions.push({ type: 'SCHEDULE_RECONNECT', delayMs: delay });
      actions.push({ type: 'EMIT_HEALTH', healthy: false });
      break;
    }

    case 'DISPATCH':
      next.sequenceNumber = event.seq;
      if (MEMBER_EVENTS.has(event.eventName)) {
        actions.push({ type: 'EMIT_MEMBER_EVENT', eventName: event.eventName, data: event.data });
      }
      break;

    case 'INVALID_SESSION':
      if (!event.resumable) {
        next.sessionId = null;
        next.sequenceNumber = null;
      }
      next.state = 'identifying';
      next.isNewSession = true;
      // Brief delay before re-identifying (Discord spec).
      actions.push({ type: 'SCHEDULE_RECONNECT', delayMs: 1000 + Math.random() * 4000 });
      break;
  }

  return { context: next, actions };
}

function reconnectDelay(attempt: number): number {
  const jitter = Math.random() * 1000;
  return Math.min(BASE_RECONNECT_MS * 2 ** attempt + jitter, MAX_RECONNECT_MS);
}
