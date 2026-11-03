import { Inject, Injectable } from '@nestjs/common';
import { AuthMethod, Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ActivityService } from '../activity/activity.service';
import { generateOpaqueToken, hashToken } from '../common/tokens';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The idle window slides at most this often, so reads don't write the session row. */
const SLIDE_INTERVAL_MS = 60 * 1000;

export interface SessionView {
  id: string;
  authMethod: AuthMethod;
  createdAt: Date;
  lastSeenAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export const SESSION_COOKIE = 'patrice_session';
export const CSRF_COOKIE = 'patrice_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

interface SessionDurations {
  absoluteDays: number;
  idleDays: number;
}

/**
 * Opaque session tokens. Only `sha256(pepper + token)` is stored; the plaintext
 * lives solely in the httpOnly cookie. Sessions carry an absolute and a sliding
 * (idle) expiry sourced from `system_settings` (defaults: 30d / 7d). A
 * paired CSRF token (double-submit) is minted alongside each session.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
  ) {}

  private async durations(): Promise<SessionDurations> {
    const s = await this.settings.get();
    return { absoluteDays: s.sessionAbsoluteDays, idleDays: s.sessionIdleDays };
  }

  /** Create a session row and return the plaintext token + CSRF token to set as cookies. */
  async create(args: {
    userId: string;
    authMethod: AuthMethod;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ token: string; csrfToken: string }> {
    const { absoluteDays, idleDays } = await this.durations();
    const token = generateOpaqueToken();
    const csrfToken = generateOpaqueToken(16);
    const now = Date.now();
    await this.prisma.session.create({
      data: {
        userId: args.userId,
        tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
        authMethod: args.authMethod,
        absoluteExpiresAt: new Date(now + absoluteDays * DAY_MS),
        idleExpiresAt: new Date(now + idleDays * DAY_MS),
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      },
    });
    return { token, csrfToken };
  }

  /**
   * Resolve a session token to its user, enforcing absolute + idle expiry and
   * sliding the idle window forward. Returns null when no valid session matches.
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    const tokenHash = hashToken(this.env.TOKEN_PEPPER, token);
    const session = await this.prisma.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        absoluteExpiresAt: true,
        idleExpiresAt: true,
        lastSeenAt: true,
        user: { select: { lifecycleState: true } },
      },
    });
    if (!session || session.revokedAt) return null;
    const now = new Date();
    if (now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) return null;
    if (session.user.lifecycleState !== 'active') return null;

    if (now.getTime() - session.lastSeenAt.getTime() >= SLIDE_INTERVAL_MS) {
      const { idleDays } = await this.durations();
      await this.prisma.session.update({
        where: { id: session.id },
        data: {
          lastSeenAt: now,
          idleExpiresAt: new Date(now.getTime() + idleDays * DAY_MS),
        },
      });
    }
    return {
      sessionId: session.id,
      userId: session.userId,
    };
  }

  /** Revoke a single session by its token (logout). */
  async revokeByToken(token: string): Promise<void> {
    const tokenHash = hashToken(this.env.TOKEN_PEPPER, token);
    await this.prisma.session.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke all of a user's active sessions (the password-reset "doubt" path), or all
   * but one (`exceptSessionId`, e.g. after a password change in that session).
   */
  async revokeAllForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
    exceptSessionId?: string,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  /** A user's live (unrevoked, unexpired) sessions, newest first. */
  async listForUser(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const now = new Date();
    const rows = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        absoluteExpiresAt: { gt: now },
        idleExpiresAt: { gt: now },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      authMethod: s.authMethod,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      ip: s.ip,
      userAgent: s.userAgent,
      current: s.id === currentSessionId,
    }));
  }

  /** The owner of a session, for authorization; null if there is no such session. */
  async ownerOf(sessionId: string): Promise<string | null> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  /** Revoke one session by id, with an audit row. Idempotent. */
  async revoke(sessionId: string, actorUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({ where: { id: sessionId }, select: { userId: true } });
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (session && count === 1) {
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: 'session',
          subjectId: sessionId,
          verb: 'session.revoked',
          payload: { sessionId, userId: session.userId },
        });
      }
    });
  }
}
