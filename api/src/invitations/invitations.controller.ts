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
import { ENV, Env } from '../config/env';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { setAuthCookies } from '../auth/cookies';
import { InvitationsService } from './invitations.service';
import { BootstrapService } from './bootstrap.service';
import { acceptInviteSchema, createInvitationSchema } from '../auth/auth.dto';
import type { AcceptInviteDto, CreateInvitationDto } from '../auth/auth.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

@Controller()
export class InvitationsController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly invitations: InvitationsService,
    private readonly bootstrap: BootstrapService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  @Get('bootstrap')
  async bootstrapStatus() {
    return this.bootstrap.getStatus();
  }

  @Get('invite/:token')
  async view(@Param('token') token: string) {
    return this.invitations.view(token);
  }

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

  @Post('invitations')
  @HttpCode(201)
  @Authorize(ACTIONS.inviteCreate.action, orgResource)
  async create(
    @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    const { id, token } = await this.invitations.create({
      creatorUserId: req.user.id,
      organizationId: req.user.organizationId,
      email: body.email ?? null,
      intendedRoleIds: body.intendedRoleIds ?? [],
      expiresAt: body.expiresAt,
    });
    // Human-facing accept page (SPA route); distinct from the API's /invite/:token.
    const url = `${this.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/accept/${token}`;
    return { id, token, url };
  }

  @Get('invitations')
  @Authorize(ACTIONS.inviteCreate.action, orgResource)
  async list(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.invitations.list(req.user.organizationId);
  }

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
  async revoke(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    if (!req.user) throw new UnauthenticatedError();
    await this.invitations.revoke(id, req.user.id);
  }
}
