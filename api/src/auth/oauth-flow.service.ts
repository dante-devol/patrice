import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken, safeEqualHex } from '../common/tokens';
import { OAuthIntent } from './providers/login-provider';

export const OAUTH_NONCE_COOKIE = 'patrice_oauth';
export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export interface StartedFlow {
  /** Sent to the provider as `state`. */
  state: string;
  /** Set as the HttpOnly nonce cookie in the browser that started the flow. */
  nonce: string;
}

export interface ConsumedFlow {
  provider: AuthProvider;
  intent: OAuthIntent;
  userId: string | null;
  inviteTokenHash: string | null;
}

/**
 * Server-side OAuth flows. The `state` the provider echoes back is an opaque token
 * that names a stored flow, and the flow only completes in the browser holding the
 * matching nonce cookie. A callback URL captured by an attacker is therefore useless
 * in a victim's browser (login CSRF), and a flow can be consumed once (replay).
 * Invite tokens never travel through the provider: the flow stores their hash.
 */
@Injectable()
export class OAuthFlowService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  async start(
    provider: AuthProvider,
    intent: OAuthIntent,
    ctx: { userId?: string; inviteToken?: string } = {},
  ): Promise<StartedFlow> {
    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const pepper = this.env.TOKEN_PEPPER;
    // Expired flows are garbage; sweep them opportunistically.
    await this.prisma.oAuthFlow.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await this.prisma.oAuthFlow.create({
      data: {
        stateHash: hashToken(pepper, state),
        nonceHash: hashToken(pepper, nonce),
        provider,
        intent,
        userId: ctx.userId ?? null,
        inviteTokenHash: ctx.inviteToken ? hashToken(pepper, ctx.inviteToken) : null,
        expiresAt: new Date(Date.now() + OAUTH_FLOW_TTL_MS),
      },
    });
    return { state, nonce };
  }

  /**
   * Consume the flow named by `state`, provided the browser presents its nonce.
   * Returns null for an unknown, expired, foreign-browser or wrong-provider flow.
   * The flow is deleted whenever its `state` is presented, so it can't be retried.
   */
  async consume(
    provider: AuthProvider,
    state: string,
    nonce: string | undefined,
  ): Promise<ConsumedFlow | null> {
    const pepper = this.env.TOKEN_PEPPER;
    const flow = await this.prisma.oAuthFlow.findUnique({
      where: { stateHash: hashToken(pepper, state) },
    });
    if (!flow) return null;
    await this.prisma.oAuthFlow.deleteMany({ where: { id: flow.id } });
    if (flow.expiresAt < new Date() || flow.provider !== provider) return null;
    if (!nonce || !safeEqualHex(flow.nonceHash, hashToken(pepper, nonce))) return null;
    return {
      provider: flow.provider,
      intent: flow.intent as OAuthIntent,
      userId: flow.userId,
      inviteTokenHash: flow.inviteTokenHash,
    };
  }
}
