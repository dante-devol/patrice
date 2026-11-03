import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * **Legacy** at-rest format for the Discord OAuth client secret, encrypted under a key
 * derived from `SESSION_SECRET`. New secrets use `SECRETS_KEY` (settings/secret-cipher);
 * the SecretStore re-encrypts a legacy handle the first time it reads it. Only the
 * decrypt path is still needed; encrypt remains for tests that seed a legacy row.
 *
 * Format: `oauthsec:<base64url(iv ‖ authTag ‖ ciphertext)>`. AES-256-GCM.
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
