import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ENV, Env } from '../config/env';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { setAuthCookies } from '../auth/cookies';
import { InvitationsService } from './invitations.service';
import { BootstrapService } from './bootstrap.service';
import { acceptInviteSchema, createInvitationSchema } from '../auth/auth.dto';
import type { AcceptInviteDto, CreateInvitationDto } from '../auth/auth.dto';
import { Public, CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller()
export class InvitationsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly invitations: InvitationsService,
    private readonly bootstrap: BootstrapService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Contract(ROUTES.bootstrapStatus)
  @Get('bootstrap')
  async bootstrapStatus() {
    return this.bootstrap.getStatus();
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Public()
  @Contract(ROUTES.viewInvite)
  @Get('invite/:token')
  async view(@Param('token') token: string) {
    return this.invitations.view(token);
  }

  // Caps invite-token + bootstrap-passcode guessing (per-IP); FCFS consumption and the
  // constant-time passcode compare remain the primary controls.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Contract(ROUTES.acceptInvite)
  @Post('invite/:token/accept')
  @HttpCode(201)
  async accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInviteSchema)) body: AcceptInviteDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId } = await this.invitations.accept({ token, ...body });
    const { token: sessionToken, csrfToken } = await this.sessions.create({
      userId,
      authMethod: AuthService.passwordAuthMethod(),
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    setAuthCookies(res, sessionToken, csrfToken, this.env.COOKIE_SECURE);
    return this.auth.getMe(userId);
  }

  @Contract(ROUTES.createInvitation)
  @Post('invitations')
  @HttpCode(201)
  @Authorize(ACTIONS.inviteCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    const { id, token } = await this.invitations.create({
      creatorUserId: user.id,
      email: body.email ?? null,
      intendedRoleIds: body.intendedRoleIds ?? [],
      expiresAt: body.expiresAt,
    });
    // Human-facing accept page (SPA route); distinct from the API's /invite/:token.
    const url = `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/accept/${token}`;
    return { id, token, url };
  }

  @Contract(ROUTES.listInvitations)
  @Get('invitations')
  @Authorize(ACTIONS.inviteCreate.action, orgResource)
  async list() {
    return this.invitations.list();
  }

  @Contract(ROUTES.revokeInvitation)
  @Post('invitations/:id/revoke')
  @HttpCode(204)
  @Authorize(ACTIONS.inviteRetire.action, async (req, prisma) => {
    const id = String(req.params.id);
    const inv = await prisma.invitation.findUnique({
      where: { id },
      select: { id: true },
    });
    return { type: 'Invitation' as const, id: inv?.id ?? id, attrs: { retired: false } };
  })
  async revoke(@Param('id') id: string, @Req() req: Request,
    @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.invitations.revoke(id, user.id);
  }
}
