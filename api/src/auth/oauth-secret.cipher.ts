import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for the **app-level Discord OAuth client secret**, which lives
 * in `organization.settings` (runtime config) rather than env (ADR 0006). The key is
 * derived from `SESSION_SECRET` via HKDF with a fixed label — the api role already
 * holds `SESSION_SECRET` (it signs sessions + OAuth state), so this needs no new env
 * and no worker round-trip (unlike the bot token's worker-only SecretCipherPort).
 *
 * Format: `oauthsec:<base64url(iv ‖ authTag ‖ ciphertext)>`. AES-256-GCM.
 * A `SESSION_SECRET` rotation makes stored handles undecryptable — the admin simply
 * re-enters the client secret (rare, and surfaced as "not configured").
 */
const TAG = 'oauthsec:';
const HKDF_INFO = Buffer.from('patrice:oauth-client-secret:v1');

function deriveKey(sessionSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32),
  );
}

export function isOAuthSecretHandle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(TAG);
}

export function encryptOAuthSecret(sessionSecret: string, plaintext: string): string {
  const key = deriveKey(sessionSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return TAG + Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

/** Throws if the handle is malformed or the key (SESSION_SECRET) no longer matches. */
export function decryptOAuthSecret(sessionSecret: string, handle: string): string {
  if (!isOAuthSecretHandle(handle)) throw new Error('not an oauthsec handle');
  const raw = Buffer.from(handle.slice(TAG.length), 'base64url');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(sessionSecret), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
