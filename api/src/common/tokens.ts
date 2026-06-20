import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { customAlphabet } from 'nanoid';

/**
 * Token + id primitives shared across auth, sessions, and invitations.
 *
 * All bearer secrets (session tokens, invite tokens, verification/reset tokens) are
 * stored only as `sha256(pepper + token)` — never in plaintext. The pepper is a
 * process-wide startup secret (`TOKEN_PEPPER`).
 */

// URL-safe, unordered alphabet for invite tokens (≥128 bits at length 24).
const inviteAlphabet =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const inviteNanoid = customAlphabet(inviteAlphabet, 24);

/** A CSPRNG opaque token (URL-safe base64). Used for sessions and auth tokens. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A CSPRNG URL-safe invite token (nanoid, ≥128 bits). */
export function generateInviteToken(): string {
  return inviteNanoid();
}

/** Hash a bearer secret for at-rest storage: sha256(pepper + token), hex. */
export function hashToken(pepper: string, token: string): string {
  return createHash('sha256').update(pepper).update(token).digest('hex');
}

/** Constant-time compare two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
