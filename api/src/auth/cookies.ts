import type { CookieOptions, Response } from 'express';
import { CSRF_COOKIE, SESSION_COOKIE } from './session.service';

/**
 * Centralised cookie policy: session is httpOnly; the CSRF token is readable by the
 * SPA (double-submit). Both are Secure (gated by COOKIE_SECURE) + SameSite=Lax.
 */
function baseOptions(secure: boolean): CookieOptions {
  return {
    secure,
    sameSite: 'lax',
    path: '/',
  };
}

export function setAuthCookies(
  res: Response,
  token: string,
  csrfToken: string,
  secure: boolean,
): void {
  res.cookie(SESSION_COOKIE, token, { ...baseOptions(secure), httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken, { ...baseOptions(secure), httpOnly: false });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  res.clearCookie(SESSION_COOKIE, { ...baseOptions(secure), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...baseOptions(secure), httpOnly: false });
}
