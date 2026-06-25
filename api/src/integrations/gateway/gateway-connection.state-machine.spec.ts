import { initialContext, handle, type GatewayContext } from './gateway-connection.state-machine';

const TOKEN = 'Bot.test.token';

const ctx = (overrides: Partial<GatewayContext> = {}): GatewayContext => ({ ...initialContext(), ...overrides });

describe('GatewayConnectionStateMachine', () => {
  it('starts in disconnected state', () => {
    expect(initialContext().state).toBe('disconnected');
  });

  describe('OPEN → HELLO → IDENTIFY', () => {
    it('transitions to connecting on OPEN', () => {
      const { context } = handle(ctx(), { type: 'OPEN' }, TOKEN);
      expect(context.state).toBe('connecting');
    });

    it('emits SEND_IDENTIFY on HELLO when no session exists', () => {
      let c = ctx();
      ({ context: c } = handle(c, { type: 'OPEN' }, TOKEN));
      const { context, actions } = handle(c, { type: 'HELLO', heartbeatInterval: 41250 }, TOKEN);
      expect(context.state).toBe('identifying');
      expect(actions).toContainEqual(expect.objectContaining({ type: 'SEND_IDENTIFY' }));
      expect(actions).not.toContainEqual(expect.objectContaining({ type: 'SEND_RESUME' }));
      expect(actions).toContainEqual(expect.objectContaining({ type: 'START_HEARTBEAT', intervalMs: 41250 }));
    });

    it('emits SEND_RESUME on HELLO when session exists', () => {
      let c = ctx({ sessionId: 'sess-1', sequenceNumber: 42 });
      ({ context: c } = handle(c, { type: 'OPEN' }, TOKEN));
      const { context, actions } = handle(c, { type: 'HELLO', heartbeatInterval: 41250 }, TOKEN);
      expect(context.state).toBe('resuming');
      expect(actions).toContainEqual(expect.objectContaining({ type: 'SEND_RESUME', sessionId: 'sess-1', seq: 42 }));
    });
  });

  describe('READY', () => {
    it('transitions to ready, stores session info, triggers reconcile (new session)', () => {
      let c = ctx();
      ({ context: c } = handle(c, { type: 'OPEN' }, TOKEN));
      ({ context: c } = handle(c, { type: 'HELLO', heartbeatInterval: 41250 }, TOKEN));
      const { context, actions } = handle(c, {
        type: 'READY',
        sessionId: 'sess-abc',
        resumeGatewayUrl: 'wss://gateway.discord.gg/v10',
      }, TOKEN);
      expect(context.state).toBe('ready');
      expect(context.sessionId).toBe('sess-abc');
      expect(context.isNewSession).toBe(true);
      expect(actions).toContainEqual({ type: 'TRIGGER_RECONCILE' });
      expect(actions).toContainEqual({ type: 'EMIT_HEALTH', healthy: true });
    });
  });

  describe('RESUMED', () => {
    it('transitions to ready, does NOT trigger reconcile (clean resume)', () => {
      let c = ctx({ sessionId: 'sess-1', sequenceNumber: 42 });
      ({ context: c } = handle(c, { type: 'OPEN' }, TOKEN));
      ({ context: c } = handle(c, { type: 'HELLO', heartbeatInterval: 41250 }, TOKEN));
      const { context, actions } = handle(c, { type: 'RESUMED' }, TOKEN);
      expect(context.state).toBe('ready');
      expect(context.isNewSession).toBe(false);
      expect(actions).not.toContainEqual(expect.objectContaining({ type: 'TRIGGER_RECONCILE' }));
      expect(actions).toContainEqual({ type: 'EMIT_HEALTH', healthy: true });
    });
  });

  describe('DISPATCH', () => {
    it('emits EMIT_MEMBER_EVENT for guild member events', () => {
      const c = ctx({ state: 'ready' });
      const { actions } = handle(c, {
        type: 'DISPATCH',
        seq: 1,
        eventName: 'GUILD_MEMBER_UPDATE',
        data: { guild_id: '123' },
      }, TOKEN);
      expect(actions).toContainEqual(expect.objectContaining({ type: 'EMIT_MEMBER_EVENT', eventName: 'GUILD_MEMBER_UPDATE' }));
    });

    it('does not emit EMIT_MEMBER_EVENT for unrelated events', () => {
      const c = ctx({ state: 'ready' });
      const { actions } = handle(c, {
        type: 'DISPATCH',
        seq: 2,
        eventName: 'MESSAGE_CREATE',
        data: {},
      }, TOKEN);
      expect(actions).not.toContainEqual(expect.objectContaining({ type: 'EMIT_MEMBER_EVENT' }));
    });
  });

  describe('CLOSE', () => {
    it('schedules reconnect and emits EMIT_HEALTH=false on close', () => {
      const c = ctx({ state: 'ready' });
      const { context, actions } = handle(c, { type: 'CLOSE', code: 1000 }, TOKEN);
      expect(context.state).toBe('disconnected');
      expect(actions).toContainEqual(expect.objectContaining({ type: 'SCHEDULE_RECONNECT' }));
      expect(actions).toContainEqual({ type: 'EMIT_HEALTH', healthy: false });
    });

    it('clears sessionId on non-resumable close code (4004)', () => {
      const c = ctx({ state: 'ready', sessionId: 'sess-1', sequenceNumber: 10 });
      const { context } = handle(c, { type: 'CLOSE', code: 4004 }, TOKEN);
      expect(context.sessionId).toBeNull();
      expect(context.sequenceNumber).toBeNull();
    });

    it('retains sessionId on resumable close code (1001)', () => {
      const c = ctx({ state: 'ready', sessionId: 'sess-1', sequenceNumber: 10 });
      const { context } = handle(c, { type: 'CLOSE', code: 1001 }, TOKEN);
      expect(context.sessionId).toBe('sess-1');
    });
  });

  describe('HEARTBEAT_MISSED', () => {
    it('marks unhealthy and schedules reconnect after 3 missed heartbeats', () => {
      let c = ctx({ state: 'ready' });
      ({ context: c } = handle(c, { type: 'HEARTBEAT_MISSED' }, TOKEN));
      ({ context: c } = handle(c, { type: 'HEARTBEAT_MISSED' }, TOKEN));
      const { context, actions } = handle(c, { type: 'HEARTBEAT_MISSED' }, TOKEN);
      expect(context.state).toBe('disconnected');
      expect(actions).toContainEqual(expect.objectContaining({ type: 'SCHEDULE_RECONNECT' }));
      expect(actions).toContainEqual({ type: 'EMIT_HEALTH', healthy: false });
    });

    it('HEARTBEAT_ACK resets miss counter', () => {
      let c = ctx({ state: 'ready' });
      ({ context: c } = handle(c, { type: 'HEARTBEAT_MISSED' }, TOKEN));
      ({ context: c } = handle(c, { type: 'HEARTBEAT_MISSED' }, TOKEN));
      ({ context: c } = handle(c, { type: 'HEARTBEAT_ACK' }, TOKEN));
      expect(c.missedHeartbeats).toBe(0);
      expect(c.state).toBe('ready');
    });
  });
});
