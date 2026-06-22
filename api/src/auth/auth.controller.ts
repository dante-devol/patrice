import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ENV, Env } from '../config/env';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { AuthService } from './auth.service';
import { SessionService, SESSION_COOKIE } from './session.service';
import { VerificationService } from './verification.service';
import { clearAuthCookies, setAuthCookies } from './cookies';
import {
  confirmVerificationSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  resendVerificationSchema,
  type ConfirmVerificationDto,
  type LoginDto,
  type PasswordResetConfirmDto,
  type PasswordResetRequestDto,
  type ResendVerificationDto,
} from './auth.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller()
export class AuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
  ) {}

  // Brute-force ceiling on password guessing (per-IP). argon2 raises per-attempt cost;
  // this caps attempt *volume*.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = await this.auth.verifyPassword(body.email, body.password);
    const { token, csrfToken } = await this.sessions.create({
      userId,
      authMethod: AuthService.passwordAuthMethod(),
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    setAuthCookies(res, token, csrfToken, this.env.COOKIE_SECURE);
    return this.auth.getMe(userId);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await this.sessions.revokeByToken(token);
    clearAuthCookies(res, this.env.COOKIE_SECURE);
  }

  @Get('me')
  async me(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.auth.getMe(req.user.id);
  }

  // Cap email-dispatch + token-guessing volume on the unauthenticated flows.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/verify-email/resend')
  @HttpCode(200)
  async resendVerification(
    @Body(new ZodValidationPipe(resendVerificationSchema)) body: ResendVerificationDto,
  ) {
    await this.verification.resendVerification(body.email);
    return { ok: true }; // unconditional success — no enumeration oracle
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/verify-email/confirm')
  @HttpCode(200)
  async confirmVerification(
    @Body(new ZodValidationPipe(confirmVerificationSchema)) body: ConfirmVerificationDto,
  ) {
    await this.verification.confirmVerification(body.token);
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('auth/password-reset')
  @HttpCode(200)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(passwordResetRequestSchema)) body: PasswordResetRequestDto,
  ) {
    await this.verification.requestPasswordReset(body.email);
    return { ok: true }; // unconditional success — no enumeration oracle
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/password-reset/confirm')
  @HttpCode(200)
  async confirmPasswordReset(
    @Body(new ZodValidationPipe(passwordResetConfirmSchema)) body: PasswordResetConfirmDto,
  ) {
    await this.verification.confirmPasswordReset(body.token, body.password);
    return { ok: true };
  }
}
