import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthMethod } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { UnauthenticatedError } from '../common/errors';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { setAuthCookies } from '../auth/cookies';
import { DiscordOAuthService } from '../auth/discord-oauth.service';
import { verifyOAuthState } from '../auth/oauth-state';
import { DiscordLinkService } from '../integrations/discord-link.service';
import { DiscordAuthService } from './discord-auth.service';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * "Continue with Discord" routes. All three flows funnel through one redirect URI
 * (`/api/auth/discord/callback`); the signed `state` carries the intent. Browser
 * navigations land here, so errors redirect to a web page with an `?error=` code
 * rather than returning a JSON envelope the user would never see.
 */
@Controller('auth/discord')
export class DiscordAuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly oauth: DiscordOAuthService,
    private readonly discordAuth: DiscordAuthService,
    private readonly link: DiscordLinkService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  private web(path: string): string {
    return `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}`;
  }

  @Get('login')
  login(@Res() res: Response): void {
    try {
      res.redirect(302, this.discordAuth.startUrl('login', {}));
    } catch {
      res.redirect(302, this.web('/login?error=discord_not_configured'));
    }
  }

  @Get('register')
  register(@Query('invite') invite: string | undefined, @Res() res: Response): void {
    if (!invite) {
      res.redirect(302, this.web('/login?error=discord_invite_required'));
      return;
    }
    try {
      res.redirect(302, this.discordAuth.startUrl('register', { inviteToken: invite }));
    } catch {
      res.redirect(302, this.web('/login?error=discord_not_configured'));
    }
  }

  /** Authenticated "Connect Discord" — pins the acting user into the signed state. */
  @Get('link')
  startLink(@Req() req: AuthedRequest, @Res() res: Response): void {
    if (!req.user) {
      res.redirect(302, this.web('/login'));
      return;
    }
    try {
      res.redirect(302, this.discordAuth.startUrl('link', { userId: req.user.id }));
    } catch {
      res.redirect(302, this.web('/account?error=discord_not_configured'));
    }
  }

  /** Disconnect the acting user's Discord account (sign-in method + links). */
  @Delete()
  @HttpCode(200)
  async unlink(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    await this.link.unlink(req.user.id);
    return this.auth.getMe(req.user.id);
  }

  // Token exchange + invite consumption happen here; cap volume per-IP.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (error || !code || !state) {
      res.redirect(302, this.web('/login?error=discord_denied'));
      return;
    }

    let payload;
    try {
      payload = verifyOAuthState(this.env.SESSION_SECRET, state, STATE_MAX_AGE_MS);
    } catch {
      res.redirect(302, this.web('/login?error=discord_state'));
      return;
    }

    try {
      const accessToken = await this.oauth.exchangeCode(code);
      const discordUser = await this.oauth.fetchUser(accessToken);

      if (payload.intent === 'login') {
        const userId = await this.discordAuth.completeLogin(discordUser);
        await this.issueSession(userId, req, res);
        res.redirect(302, this.web('/home'));
        return;
      }

      if (payload.intent === 'register' && payload.inviteToken) {
        const userId = await this.discordAuth.completeRegister(payload.inviteToken, discordUser);
        await this.issueSession(userId, req, res);
        res.redirect(302, this.web('/home'));
        return;
      }

      if (payload.intent === 'link' && payload.userId) {
        // The connect must finish under the same session that started it; the Lax
        // session cookie rides this top-level GET, so re-check the live user.
        const authedReq = req as AuthedRequest;
        if (!authedReq.user || authedReq.user.id !== payload.userId) {
          res.redirect(302, this.web('/account?error=discord_session'));
          return;
        }
        await this.link.completeLink(payload.userId, discordUser);
        res.redirect(302, this.web('/account?linked=1'));
        return;
      }

      res.redirect(302, this.web('/login?error=discord_unsupported'));
    } catch (e) {
      const dest = payload.intent === 'link' ? '/account' : '/login';
      res.redirect(302, this.web(`${dest}?error=${this.codeOf(e)}`));
    }
  }

  private async issueSession(userId: string, req: Request, res: Response): Promise<void> {
    const { token, csrfToken } = await this.sessions.create({
      userId,
      authMethod: AuthMethod.discord,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    setAuthCookies(res, token, csrfToken, this.env.COOKIE_SECURE);
  }

  /** Map a thrown error to a lowercase web `?error=` code. */
  private codeOf(e: unknown): string {
    if (e instanceof HttpException) {
      const body = e.getResponse() as { error?: { code?: string } };
      if (body?.error?.code) return body.error.code.toLowerCase();
    }
    return 'discord_error';
  }
}
