import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DeniedError } from '../common/errors';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  SessionService,
} from './session.service';
import { safeEqualHex } from '../common/tokens';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface CookieRequest extends Request {
  user?: { id: string; organizationId: string };
  sessionId?: string;
}

/**
 * Global session resolver. Attaches `req.user` when a valid session cookie is
 * present (identity only — permissions come from the access engine per request).
 * Enforces CSRF (double-submit) on cookie-authenticated mutations; SameSite=Lax is
 * the first line of defence, the header check is defence-in-depth.
 *
 * This guard never denies for *lack* of a session — gated routes get their 401 from
 * the AuthorizeGuard. It only denies on a failed CSRF check.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CookieRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const resolved = await this.sessions.resolve(token);
      if (resolved) {
        req.user = { id: resolved.userId, organizationId: resolved.organizationId };
        req.sessionId = resolved.sessionId;

        if (MUTATING.has(req.method)) {
          this.enforceCsrf(req);
        }
      }
    }
    return true;
  }

  private enforceCsrf(req: CookieRequest): void {
    const cookieToken = req.cookies?.[CSRF_COOKIE];
    const headerToken = req.header(CSRF_HEADER);
    const ok =
      !!cookieToken &&
      !!headerToken &&
      cookieToken.length === headerToken.length &&
      timingEqual(cookieToken, headerToken);
    if (!ok) {
      throw new DeniedError('CSRF_FAILED', 'Missing or invalid CSRF token');
    }
  }
}

/** Constant-time string compare for CSRF tokens (base64url, not hex). */
function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Re-exported for callers that compare hashed tokens elsewhere.
export { safeEqualHex };
