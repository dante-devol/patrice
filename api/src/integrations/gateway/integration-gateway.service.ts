import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { WebSocket } from 'ws';
import { PrismaService } from '../../prisma/prisma.service';
import { SyncService } from '../sync/sync.service';
import { SECRET_CIPHER_PORT, type SecretCipherPort } from '../secret-cipher.port';
import { PROCESS_ROLE, isWorkerRole, type ProcessRoleValue } from '../../common/process-role';
import {
  initialContext,
  handle,
  type GatewayContext,
  type GatewayEvent,
  type GatewayAction,
} from './gateway-connection.state-machine';

const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

// Gateway intents: GUILD_MEMBERS (1 << 1) + GUILDS (1 << 0)
const INTENTS = (1 << 0) | (1 << 1);

interface GatewaySession {
  connectionId: string;
  botToken: string;
  ws: WebSocket | null;
  ctx: GatewayContext;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  healthy: boolean;
}

/**
 * Discord Gateway Doorbell listener (#61).
 *
 * Worker-role only. Maintains one WebSocket per unique bot token.
 * On relevant events it calls SyncService.enqueueSoon(connectionId) — never
 * writes user_role directly (Doorbell pattern: the reconciler is the sole writer).
 *
 * Uses the pure GatewayConnectionStateMachine for session management.
 */
@Injectable()
export class IntegrationGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntegrationGatewayService.name);
  private readonly sessions = new Map<string, GatewaySession>(); // key: connectionId

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => SyncService)) private readonly sync: SyncService,
    @Inject(SECRET_CIPHER_PORT) private readonly cipher: SecretCipherPort,
    @Inject(PROCESS_ROLE) private readonly processRole: ProcessRoleValue,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isWorkerRole(this.processRole)) return;
    await this.openAllSessions();
  }

  async onModuleDestroy(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.closeSession(session);
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Public: called by admin actions (new connection added, token rotated, retired)
  // ---------------------------------------------------------------------------

  async openSession(connectionId: string): Promise<void> {
    const conn = await this.prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.lifecycleState !== 'active') return;
    const botToken = await this.resolveToken(conn);
    if (!botToken) return;
    this.startSession(connectionId, botToken);
  }

  closeSessionById(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (session) {
      this.closeSession(session);
      this.sessions.delete(connectionId);
    }
  }

  isHealthy(connectionId: string): boolean {
    return this.sessions.get(connectionId)?.healthy ?? false;
  }

  // ---------------------------------------------------------------------------
  // Private session management
  // ---------------------------------------------------------------------------

  private async openAllSessions(): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { lifecycleState: 'active' },
    });
    for (const conn of connections) {
      const botToken = await this.resolveToken(conn).catch(() => null);
      if (botToken) this.startSession(conn.id, botToken);
    }
  }

  private startSession(connectionId: string, botToken: string): void {
    if (this.sessions.has(connectionId)) {
      this.closeSessionById(connectionId);
    }
    const session: GatewaySession = {
      connectionId,
      botToken,
      ws: null,
      ctx: initialContext(),
      heartbeatTimer: null,
      reconnectTimer: null,
      healthy: false,
    };
    this.sessions.set(connectionId, session);
    this.connect(session);
  }

  private connect(session: GatewaySession): void {
    const url = session.ctx.resumeGatewayUrl ?? DISCORD_GATEWAY_URL;
    const ws = new WebSocket(url);
    session.ws = ws;

    ws.on('open', () => this.dispatch(session, { type: 'OPEN' }));
    ws.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          op: number;
          d: unknown;
          s: number | null;
          t: string | null;
        };
        this.handlePayload(session, payload);
      } catch (err) {
        this.logger.error(`Gateway parse error: ${(err as Error).message}`);
      }
    });
    ws.on('close', (code) => this.dispatch(session, { type: 'CLOSE', code }));
    ws.on('error', (err) => {
      this.logger.error(`Gateway WS error (${session.connectionId}): ${err.message}`);
      ws.close(1011);
    });
  }

  private handlePayload(
    session: GatewaySession,
    payload: { op: number; d: unknown; s: number | null; t: string | null },
  ): void {
    const { op, d, s, t } = payload;

    // op 10 = Hello
    if (op === 10) {
      const hi = d as { heartbeat_interval: number };
      this.dispatch(session, { type: 'HELLO', heartbeatInterval: hi.heartbeat_interval });
      return;
    }
    // op 11 = Heartbeat ACK
    if (op === 11) { this.dispatch(session, { type: 'HEARTBEAT_ACK' }); return; }
    // op 1 = Heartbeat request
    if (op === 1) {
      session.ws?.send(JSON.stringify({ op: 1, d: session.ctx.sequenceNumber }));
      return;
    }
    // op 9 = Invalid Session
    if (op === 9) { this.dispatch(session, { type: 'INVALID_SESSION', resumable: !!(d) }); return; }
    // op 0 = Dispatch
    if (op === 0 && t && s !== null) {
      if (t === 'READY') {
        const r = d as { session_id: string; resume_gateway_url: string };
        this.dispatch(session, { type: 'READY', sessionId: r.session_id, resumeGatewayUrl: r.resume_gateway_url });
      } else if (t === 'RESUMED') {
        this.dispatch(session, { type: 'RESUMED' });
      } else {
        this.dispatch(session, { type: 'DISPATCH', seq: s, eventName: t, data: d });
      }
    }
  }

  private dispatch(session: GatewaySession, event: GatewayEvent): void {
    const { context, actions } = handle(session.ctx, event, session.botToken);
    session.ctx = context;
    for (const action of actions) {
      this.execute(session, action);
    }
  }

  private execute(session: GatewaySession, action: GatewayAction): void {
    switch (action.type) {
      case 'SEND_IDENTIFY':
        session.ws?.send(JSON.stringify({
          op: 2,
          d: { token: action.token, intents: INTENTS, properties: { os: 'linux', browser: 'patrice', device: 'patrice' } },
        }));
        break;

      case 'SEND_RESUME':
        session.ws?.send(JSON.stringify({
          op: 6,
          d: { token: action.token, session_id: action.sessionId, seq: action.seq },
        }));
        break;

      case 'SEND_HEARTBEAT':
        session.ws?.send(JSON.stringify({ op: 1, d: action.seq }));
        break;

      case 'START_HEARTBEAT':
        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = setInterval(() => {
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ op: 1, d: session.ctx.sequenceNumber }));
          } else {
            this.dispatch(session, { type: 'HEARTBEAT_MISSED' });
          }
        }, action.intervalMs);
        break;

      case 'SCHEDULE_RECONNECT':
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.ws = null;
        session.reconnectTimer = setTimeout(() => {
          if (this.sessions.has(session.connectionId)) {
            this.connect(session);
          }
        }, action.delayMs);
        break;

      case 'EMIT_MEMBER_EVENT':
        // Doorbell: enqueue reconcile for this connection. Never writes user_role.
        this.sync.enqueueSoon(session.connectionId).catch((err) => {
          this.logger.error(`enqueueSoon failed: ${(err as Error).message}`);
        });
        break;

      case 'TRIGGER_RECONCILE':
        this.sync.enqueue(session.connectionId).catch((err) => {
          this.logger.error(`enqueue (reconcile-on-connect) failed: ${(err as Error).message}`);
        });
        break;

      case 'EMIT_HEALTH':
        session.healthy = action.healthy;
        this.sync.setGatewayHealth(session.connectionId, action.healthy);
        if (!action.healthy) {
          this.logger.warn(`Gateway unhealthy for connection ${session.connectionId}`);
        }
        break;
    }
  }

  private closeSession(session: GatewaySession): void {
    if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.ws?.close(1000);
    session.ws = null;
  }

  private async resolveToken(conn: { config: unknown; credentialsRef: string | null }): Promise<string | null> {
    if (conn.credentialsRef && this.cipher.canHandle(conn.credentialsRef)) {
      return this.cipher.decrypt(conn.credentialsRef).catch(() => null);
    }
    return (conn.config as Record<string, string>)['botToken'] ?? null;
  }
}
