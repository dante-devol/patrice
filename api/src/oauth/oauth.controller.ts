import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthMethod } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { DomainError } from '../domain/shared/domain-error';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { setAuthCookies } from '../auth/cookies';
import { OAUTH_FLOW_TTL_MS, OAUTH_NONCE_COOKIE } from '../auth/oauth-flow.service';
import { OAuthIntent } from '../auth/providers/login-provider';
import { CurrentUser, Public, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { OAuthCallbackError, OAuthLoginService } from './oauth-login.service';

/**
 * Sign-in provider routes (`/auth/:provider/...`, e.g. `/auth/discord/login`). Every
 * flow for a provider funnels through its one callback URI. These are browser
 * navigations, so errors redirect to a web page with an `?error=` code rather than
 * returning a JSON envelope the user would never see.
 */
@Controller('auth/:provider')
export class OAuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly login: OAuthLoginService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  private web(path: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  /** Start a flow and send the browser to the provider, holding the flow's nonce. */
  private async begin(
    res: Response,
    provider: string,
    intent: OAuthIntent,
    ctx: { userId?: string; inviteToken?: string },
    failTo: string,
  ): Promise<void> {
    try {
      const { url, nonce } = await this.login.start(provider, intent, ctx);
      res.cookie(OAUTH_NONCE_COOKIE, nonce, {
        httpOnly: true,
        secure: this.env.COOKIE_SECURE,
        sameSite: 'lax',
        path: '/',
        maxAge: OAUTH_FLOW_TTL_MS,
      });
      res.redirect(302, url);
    } catch {
      res.redirect(302, this.web(`${failTo}?error=${provider}_not_configured`));
    }
  }

  @Public()
  @Contract(ROUTES.oauthLogin)
  @Get('login')
  async start(@Param('provider') provider: string, @Res() res: Response): Promise<void> {
    await this.begin(res, provider, 'login', {}, '/login');
  }

  @Public()
  @Contract(ROUTES.oauthRegister)
  @Get('register')
  async register(
    @Param('provider') provider: string,
    @Query('invite') invite: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!invite) {
      res.redirect(302, this.web('/login?error=invite_missing'));
      return;
    }
    await this.begin(res, provider, 'register', { inviteToken: invite }, `/invite/${encodeURIComponent(invite)}`);
  }

  /** Connect a provider to the signed-in account. */
  @Public()
  @Contract(ROUTES.oauthLink)
  @Get('link')
  async startLink(
    @Param('provider') provider: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!req.user) {
      res.redirect(302, this.web('/login'));
      return;
    }
    await this.begin(res, provider, 'link', { userId: req.user.id }, '/account');
  }

  /** Disconnect a provider from the signed-in account. */
  @Contract(ROUTES.oauthUnlink)
  @Delete()
  @HttpCode(200)
  async unlink(@Param('provider') provider: string, @CurrentUser() user: CurrentUserRef) {
    await this.login.disconnect(user.id, provider);
    return this.auth.getMe(user.id);
  }

  // Token exchange and invite consumption happen here; cap volume per IP.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Public()
  @Contract(ROUTES.oauthCallback)
  @Get('callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const nonce = req.cookies?.[OAUTH_NONCE_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_NONCE_COOKIE, { path: '/' });
    if (error || !code || !state) {
      res.redirect(302, this.web(`/login?error=${provider}_denied`));
      return;
    }
    let intent: OAuthIntent | undefined;
    try {
      const outcome = await this.login.complete({
        providerId: provider,
        state,
        nonce,
        code,
        sessionUserId: req.user?.id,
      });
      intent = outcome.intent;
      if (outcome.kind === 'linked') {
        res.redirect(302, this.web('/account?linked=1'));
        return;
      }
      const { token, csrfToken } = await this.sessions.create({
        userId: outcome.userId,
        authMethod: provider as AuthMethod,
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });
      setAuthCookies(res, token, csrfToken, this.env.COOKIE_SECURE);
      res.redirect(302, this.web('/home'));
    } catch (e) {
      const dest = intent === 'link' || (e instanceof OAuthCallbackError && e.reason === 'session')
        ? '/account'
        : '/login';
      res.redirect(302, this.web(`${dest}?error=${this.codeOf(e, provider)}`));
    }
  }

  /** Map a thrown error to a lowercase web `?error=` code. */
  private codeOf(e: unknown, provider: string): string {
    if (e instanceof OAuthCallbackError) return `${provider}_${e.reason}`;
    if (e instanceof DomainError) {
      const taken = e.code === 'IDENTITY_TAKEN' || e.code === 'PROVIDER_ALREADY_CONNECTED';
      return taken ? `${provider}_already_linked` : e.code.toLowerCase();
    }
    if (e instanceof HttpException) {
      const body = e.getResponse() as { error?: { code?: string } };
      if (body?.error?.code) return body.error.code.toLowerCase();
    }
    return `${provider}_error`;
  }
}
