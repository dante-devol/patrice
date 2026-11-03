import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, sessionResource, userSessionsResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { AccountService } from './account.service';
import { SessionService } from './session.service';
import { VerificationService } from './verification.service';
import { CurrentUser, Public, type CurrentUserRef } from './current-user';
import {
  confirmEmailChangeSchema,
  requestEmailChangeSchema,
  setPasswordSchema,
  type ConfirmEmailChangeDto,
  type RequestEmailChangeDto,
  type SetPasswordDto,
} from './auth.dto';

/** Self-service account management: password, email and sessions. */
@Controller()
export class AccountController {
  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly verification: VerificationService,
  ) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Contract(ROUTES.setPassword)
  @Post('me/password')
  @HttpCode(204)
  async setPassword(
    @Body(new ZodValidationPipe(setPasswordSchema)) body: SetPasswordDto,
    @CurrentUser() user: CurrentUserRef,
    @Req() req: Request,
  ): Promise<void> {
    await this.accounts.setPassword(user.id, req.sessionId, body);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Contract(ROUTES.requestEmailChange)
  @Post('me/email')
  @HttpCode(200)
  async requestEmailChange(
    @Body(new ZodValidationPipe(requestEmailChangeSchema)) body: RequestEmailChangeDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    await this.accounts.requestEmailChange(user.id, body);
    return { ok: true as const };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Contract(ROUTES.confirmEmailChange)
  @Post('auth/email-change/confirm')
  @HttpCode(200)
  async confirmEmailChange(
    @Body(new ZodValidationPipe(confirmEmailChangeSchema)) body: ConfirmEmailChangeDto,
  ) {
    await this.verification.confirmEmailChange(body.token);
    return { ok: true as const };
  }

  @Contract(ROUTES.listMySessions)
  @Get('me/sessions')
  async mySessions(@CurrentUser() user: CurrentUserRef, @Req() req: Request) {
    return this.sessions.listForUser(user.id, req.sessionId);
  }

  @Contract(ROUTES.listUserSessions)
  @Get('users/:id/sessions')
  @Authorize(ACTIONS.sessionRevoke.action, userSessionsResource)
  async userSessions(@Param('id') id: string, @Req() req: Request) {
    return this.sessions.listForUser(id, req.sessionId);
  }

  /** End one session: your own always, anyone else's with `session:revoke`. */
  @Contract(ROUTES.revokeSession)
  @Delete('sessions/:id')
  @HttpCode(204)
  @Authorize(ACTIONS.sessionRevoke.action, sessionResource)
  async revoke(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.sessions.revoke(id, user.id);
  }
}
