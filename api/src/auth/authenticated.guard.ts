import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { UnauthenticatedError } from '../common/errors';
import { PUBLIC_META } from './current-user';

/**
 * Requires a session on every route not marked `@Public()`. Runs after the
 * SessionGuard (which resolves `req.user`) and before the AuthorizeGuard.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (!context.switchToHttp().getRequest<Request>().user) throw new UnauthenticatedError();
    return true;
  }
}
