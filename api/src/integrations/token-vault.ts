import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ENV, Env } from '../config/env';

const TAG = 'aead';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Bot-token custody: AES-256-GCM under `INTEGRATION_TOKEN_KEY`, which only the worker
 * holds. It is provided only in the worker, and the worker refuses to start without
 * the key; there is no plaintext fallback. The API never encrypts: it hands a new
 * token to the worker in an `integration.store-token` job (problems D13).
 *
 * A stored handle is `aead:<base64(iv | ciphertext | authTag)>`.
 */
@Injectable()
export class TokenVault {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    if (!env.INTEGRATION_TOKEN_KEY) {
      throw new Error('INTEGRATION_TOKEN_KEY is required in the worker (64 hex characters)');
    }
    this.key = Buffer.from(env.INTEGRATION_TOKEN_KEY, 'hex');
  }

  /** Whether a stored handle is one this vault can open. */
  static isHandle(ref: string | null | undefined): ref is string {
    return typeof ref === 'string' && ref.startsWith(`${TAG}:`);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${TAG}:${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64')}`;
  }

  decrypt(ref: string): string {
    if (!TokenVault.isHandle(ref)) throw new Error('Not a token-vault handle');
    const blob = Buffer.from(ref.slice(TAG.length + 1), 'base64');
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
    const ct = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct, undefined, 'utf8') + decipher.final('utf8');
  }
}
