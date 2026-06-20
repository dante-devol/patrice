import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { DeniedError, UnauthenticatedError } from '../common/errors';
import { AccessService } from './access.service';
import { AUTHORIZE_META, AuthorizeMeta } from './authorize.decorator';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Route guard that enforces the declared `@Authorize(...)` action via the Cedar
 * engine. Routes without `@Authorize` are not gated here (auth/session concerns
 * are handled by the SessionGuard). A missing session on a gated route is a 401;
 * a Cedar deny is a 403.
 */
@Injectable()
export class AuthorizeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AuthorizeMeta | undefined>(
      AUTHORIZE_META,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) return true; // route is not access-gated

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) {
      throw new UnauthenticatedError();
    }

    const resource = await meta.resolveResource(req, this.prisma);
    const allowed = await this.access.decide({
      userId: req.user.id,
      action: meta.action,
      resource,
    });
    if (!allowed) {
      throw new DeniedError('FORBIDDEN', `Not permitted: ${meta.action}`);
    }
    return true;
  }
}
