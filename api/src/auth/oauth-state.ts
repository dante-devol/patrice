import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, self-contained OAuth `state`. There is no server-side session to bind to
 * on the unauthenticated login/register flows, so CSRF/replay defence rests on an
 * HMAC over the payload (SESSION_SECRET) plus a short expiry and a random nonce —
 * the standard stateless-state pattern. `link` (authenticated) additionally pins
 * `userId`, which the callback re-checks against the live session.
 */
export interface OAuthStatePayload {
  intent: 'login' | 'register' | 'link';
  /** register: the bearer invite token to redeem. */
  inviteToken?: string;
  /** link: the user who initiated the connect (re-checked against the session). */
  userId?: string;
  nonce: string;
  /** issued-at, epoch ms. */
  iat: number;
}

export function signOAuthState(
  secret: string,
  payload: Omit<OAuthStatePayload, 'nonce' | 'iat'>,
): string {
  const full: OAuthStatePayload = {
    ...payload,
    nonce: randomBytes(12).toString('hex'),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Throws a plain Error on a malformed/forged/expired state — callers map to a 422. */
export function verifyOAuthState(
  secret: string,
  raw: string,
  maxAgeMs: number,
): OAuthStatePayload {
  const dot = raw.lastIndexOf('.');
  if (dot < 0) throw new Error('malformed state');
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('bad state signature');
  }
  const payload = JSON.parse(
    Buffer.from(body, 'base64url').toString(),
  ) as OAuthStatePayload;
  if (typeof payload.iat !== 'number' || Date.now() - payload.iat > maxAgeMs) {
    throw new Error('state expired');
  }
  return payload;
}
