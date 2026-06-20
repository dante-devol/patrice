import { Inject, Injectable } from '@nestjs/common';
import { AuthMethod, Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../common/tokens';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_DAYS = 30;
const DEFAULT_IDLE_DAYS = 7;

export const SESSION_COOKIE = 'patrice_session';
export const CSRF_COOKIE = 'patrice_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  organizationId: string;
}

interface SessionDurations {
  absoluteDays: number;
  idleDays: number;
}

/**
 * Opaque session tokens. Only `sha256(pepper + token)` is stored; the plaintext
 * lives solely in the httpOnly cookie. Sessions carry an absolute and a sliding
 * (idle) expiry sourced from `organization.settings` (defaults: 30d / 7d). A
 * paired CSRF token (double-submit) is minted alongside each session.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  private async durations(): Promise<SessionDurations> {
    const org = await this.prisma.organization.findFirstOrThrow({
      select: { settings: true },
    });
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    return {
      absoluteDays:
        typeof settings.sessionAbsoluteDays === 'number'
          ? settings.sessionAbsoluteDays
          : DEFAULT_ABSOLUTE_DAYS,
      idleDays:
        typeof settings.sessionIdleDays === 'number'
          ? settings.sessionIdleDays
          : DEFAULT_IDLE_DAYS,
    };
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
        user: { select: { organizationId: true, lifecycleState: true } },
      },
    });
    if (!session || session.revokedAt) return null;
    const now = new Date();
    if (now >= session.absoluteExpiresAt || now >= session.idleExpiresAt) return null;
    if (session.user.lifecycleState !== 'active') return null;

    const { idleDays } = await this.durations();
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + idleDays * DAY_MS),
      },
    });
    return {
      sessionId: session.id,
      userId: session.userId,
      organizationId: session.user.organizationId,
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

  /** Revoke all of a user's active sessions (the password-reset "doubt" path). */
  async revokeAllForUser(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
