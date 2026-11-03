import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { SecretPurpose } from './secret-store.service';

/**
 * AES-256-GCM encryption for secrets stored in the database. Each purpose gets its own
 * key, derived from SECRETS_KEY with HKDF, and the purpose is also bound as additional
 * authenticated data, so a ciphertext can't be replayed under a different purpose.
 *
 * Format: `sec1:<base64url(iv ‖ authTag ‖ ciphertext)>`.
 */
const TAG = 'sec1:';

function keyFor(rootHex: string, purpose: SecretPurpose): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(rootHex, 'hex'), Buffer.alloc(0), `patrice:secret:${purpose}`, 32),
  );
}

export function isSecretHandle(value: string): boolean {
  return value.startsWith(TAG);
}

export function encryptSecret(rootHex: string, purpose: SecretPurpose, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(rootHex, purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return TAG + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/** Throws if the handle is malformed, was made for another purpose, or the key changed. */
export function decryptSecret(rootHex: string, purpose: SecretPurpose, handle: string): string {
  if (!isSecretHandle(handle)) throw new Error('not a sec1 handle');
  const raw = Buffer.from(handle.slice(TAG.length), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(rootHex, purpose), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
