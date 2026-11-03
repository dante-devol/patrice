import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError, UnauthenticatedError, UnprocessableError } from '../common/errors';
import { DomainError } from '../domain/shared/domain-error';
import { InvitationsService } from '../invitations/invitations.service';
import { AccountService } from '../auth/account.service';
import { OAuthFlowService, StartedFlow } from '../auth/oauth-flow.service';
import { LOGIN_PROVIDERS, LoginProvider, OAuthIntent } from '../auth/providers/login-provider';

export type ExternalProvider = Exclude<AuthProvider, 'password'>;

/**
 * A callback the flow itself rejects: an unknown, expired, replayed or foreign-browser
 * `state`, or a link finishing outside the session that started it. The controller
 * turns `reason` into the web's `?error=<provider>_<reason>` code.
 */
export class OAuthCallbackError extends Error {
  constructor(readonly reason: 'state' | 'session') {
    super(`OAuth callback rejected: ${reason}`);
  }
}

/** What the callback did: sign a user in, or attach a method to the signed-in user. */
export type CallbackOutcome = { kind: 'session'; userId: string } | { kind: 'linked' };

/**
 * OAuth sign-in for every provider in the slot: login, invite registration, and
 * linking a provider to the signed-in account. Account creation stays invite-only;
 * a login that matches no identity is refused, never auto-provisioned.
 */
@Injectable()
export class OAuthLoginService {
  private readonly providers: Map<string, LoginProvider>;

  constructor(
    @Inject(LOGIN_PROVIDERS) providers: LoginProvider[],
    private readonly prisma: PrismaService,
    private readonly flows: OAuthFlowService,
    private readonly invitations: InvitationsService,
    private readonly accounts: AccountService,
  ) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }

  provider(id: string): LoginProvider {
    const p = this.providers.get(id);
    if (!p) throw new NotFoundError('NOT_FOUND', `Unknown sign-in provider "${id}"`);
    return p;
  }

  async start(
    providerId: string,
    intent: OAuthIntent,
    ctx: { userId?: string; inviteToken?: string } = {},
  ): Promise<StartedFlow & { url: string }> {
    const provider = this.provider(providerId);
    if (!(await provider.isConfigured())) {
      throw new UnprocessableError('DISCORD_NOT_CONFIGURED', `${providerId} sign-in is not configured`);
    }
    const flow = await this.flows.start(provider.id, intent, ctx);
    return { ...flow, url: await provider.authorizeUrl(flow.state, intent) };
  }

  /**
   * Finish a flow. `sessionUserId` is the browser's current session user; a link
   * flow must finish under the same session that started it.
   */
  async complete(args: {
    providerId: string;
    state: string;
    nonce: string | undefined;
    code: string;
    sessionUserId: string | undefined;
  }): Promise<CallbackOutcome & { intent: OAuthIntent }> {
    const provider = this.provider(args.providerId);
    const flow = await this.flows.consume(provider.id, args.state, args.nonce);
    if (!flow) throw new OAuthCallbackError('state');
    const id = provider.id as ExternalProvider;

    if (flow.intent === 'link') {
      if (!flow.userId || flow.userId !== args.sessionUserId) throw new OAuthCallbackError('session');
      const profile = await provider.exchange(args.code);
      await this.accounts.attachIdentity(flow.userId, id, profile);
      await provider.afterLink?.(flow.userId, profile);
      return { kind: 'linked', intent: 'link' };
    }

    const profile = await provider.exchange(args.code);
    if (flow.intent === 'register' && flow.inviteTokenHash) {
      const { userId } = await this.invitations.acceptWithProvider({
        inviteTokenHash: flow.inviteTokenHash,
        provider: id,
        providerSubject: profile.subject,
        email: profile.email,
        displayName: profile.displayName ?? profile.username,
      });
      return { kind: 'session', userId, intent: 'register' };
    }

    const identity = await this.prisma.userIdentity.findUnique({
      where: { provider_providerSubject: { provider: id, providerSubject: profile.subject } },
      select: { userId: true, user: { select: { lifecycleState: true } } },
    });
    if (!identity || identity.user.lifecycleState !== 'active') {
      throw new UnauthenticatedError(
        'DISCORD_NO_ACCOUNT',
        `No active Patrice account is linked to this ${args.providerId} login`,
      );
    }
    return { kind: 'session', userId: identity.userId, intent: 'login' };
  }

  /** Disconnect a provider from the account (never the last sign-in method). */
  async disconnect(userId: string, providerId: string): Promise<void> {
    const provider = this.provider(providerId);
    let detached = false;
    try {
      await this.accounts.detachIdentity(userId, provider.id);
      detached = true;
    } catch (e) {
      if (!(e instanceof DomainError && e.code === 'NOT_LINKED')) throw e;
    }
    const cleaned = (await provider.afterUnlink?.(userId)) ?? false;
    if (!detached && !cleaned) {
      throw new UnprocessableError('NOT_LINKED', `No ${providerId} account is connected`);
    }
  }
}
