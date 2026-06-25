import { Injectable, Inject, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ENV, Env } from '../config/env';
import type { SecretCipherPort } from './secret-cipher.port';

const TAG = 'aead';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Inline AES-256-GCM adapter for SecretCipherPort (#57).
 *
 * Handle format: `aead:<base64(iv | ciphertext | authTag)>`
 *
 * Key sourced from INTEGRATION_TOKEN_KEY (32-byte hex). If the key is absent
 * this adapter throws on encrypt/decrypt — the DiscordAdapter falls back to
 * config.botToken for backwards compat until all connections are migrated.
 */
@Injectable()
export class AeadEnvAdapter implements SecretCipherPort {
  private readonly logger = new Logger(AeadEnvAdapter.name);
  private readonly key: Buffer | null;

  constructor(@Inject(ENV) env: Env) {
    this.key = env.INTEGRATION_TOKEN_KEY
      ? Buffer.from(env.INTEGRATION_TOKEN_KEY, 'hex')
      : null;
  }

  canHandle(ref: string): boolean {
    return ref.startsWith(`${TAG}:`);
  }

  async encrypt(plaintext: string): Promise<string> {
    if (!this.key) throw new Error('INTEGRATION_TOKEN_KEY is not set; cannot encrypt');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, ct, tag]);
    return `${TAG}:${blob.toString('base64')}`;
  }

  async decrypt(ref: string): Promise<string> {
    if (!this.key) throw new Error('INTEGRATION_TOKEN_KEY is not set; cannot decrypt');
    if (!this.canHandle(ref)) throw new Error(`AeadEnvAdapter cannot handle ref: ${ref}`);
    const blob = Buffer.from(ref.slice(TAG.length + 1), 'base64');
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
    const ct = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct) + decipher.final('utf8');
  }
}
