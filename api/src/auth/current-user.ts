import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

/** The signed-in user, as resolved from the session cookie by the SessionGuard. */
export interface CurrentUserRef {
  id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the SessionGuard when a valid session cookie is present. */
      user?: CurrentUserRef;
      sessionId?: string;
    }
  }
}

export const PUBLIC_META = 'patrice:public';

/**
 * Marks a route (or controller) as reachable without a session. Every other route
 * gets a 401 from the AuthenticatedGuard when no valid session is present.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_META, true);

/**
 * The signed-in user. Only valid on non-public routes, where the AuthenticatedGuard
 * has already guaranteed a session.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserRef => {
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new Error('@CurrentUser() used on a route without a session');
    return user;
  },
);
