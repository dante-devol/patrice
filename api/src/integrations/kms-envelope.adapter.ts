import { Injectable, Inject, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ENV, Env } from '../config/env';
import type { SecretCipherPort } from './secret-cipher.port';

const TAG = 'kms';
const DEK_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * AWS KMS envelope encryption adapter for SecretCipherPort (#62).
 *
 * Handle format: `kms:<keyId>:<base64(encryptedDek|iv|ciphertext|authTag)>`
 *
 * Envelope pattern:
 *  1. Generate a random DEK (data encryption key).
 *  2. Encrypt the plaintext with DEK (AES-256-GCM).
 *  3. Encrypt the DEK with the KMS CMK.
 *  4. Store: encrypted-DEK | IV | ciphertext | authTag.
 *
 * The master key (CMK) never touches Patrice; a stolen DB yields only ciphertext.
 *
 * Requires:
 *   KMS_KEY_ID    — KMS key ARN / alias
 *   AWS_REGION    — AWS region (falls back to AWS SDK default chain)
 *
 * Note: The AWS SDK (`@aws-sdk/client-kms`) is intentionally NOT imported here
 * to avoid adding it as a hard dep in the base image. The adapter dynamically
 * requires it so it only fails at runtime when KMS refs are actually used.
 * Install `@aws-sdk/client-kms` in the worker Dockerfile.
 */
@Injectable()
export class KmsEnvelopeAdapter implements SecretCipherPort {
  private readonly logger = new Logger(KmsEnvelopeAdapter.name);
  private readonly keyId: string | undefined;
  private readonly region: string | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.keyId = env.KMS_KEY_ID;
    this.region = env.AWS_REGION;
  }

  canHandle(ref: string): boolean {
    return ref.startsWith(`${TAG}:`);
  }

  async encrypt(plaintext: string): Promise<string> {
    this.assertConfigured();
    const { KMSClient, GenerateDataKeyCommand } = await this.kmsClient();
    const client = new KMSClient({ region: this.region });
    const resp = await client.send(new GenerateDataKeyCommand({
      KeyId: this.keyId,
      KeySpec: 'AES_256',
    }));
    const dek = Buffer.from(resp.Plaintext!);
    const encryptedDek = Buffer.from(resp.CiphertextBlob!);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(DEK_ALGO, dek, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Zeroize DEK immediately.
    dek.fill(0);

    const blob = Buffer.concat([
      Buffer.from([encryptedDek.length >> 8, encryptedDek.length & 0xff]), // 2-byte len
      encryptedDek,
      iv,
      ct,
      tag,
    ]);
    return `${TAG}:${this.keyId}:${blob.toString('base64')}`;
  }

  async decrypt(ref: string): Promise<string> {
    this.assertConfigured();
    if (!this.canHandle(ref)) throw new Error(`KmsEnvelopeAdapter cannot handle ref: ${ref}`);
    const parts = ref.split(':');
    // tag : keyId : blob  (keyId may contain colons in ARN form)
    const blob = Buffer.from(parts[parts.length - 1], 'base64');

    const dekLen = (blob[0] << 8) | blob[1];
    const encryptedDek = blob.subarray(2, 2 + dekLen);
    const iv = blob.subarray(2 + dekLen, 2 + dekLen + IV_BYTES);
    const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
    const ct = blob.subarray(2 + dekLen + IV_BYTES, blob.length - AUTH_TAG_BYTES);

    const { KMSClient, DecryptCommand } = await this.kmsClient();
    const client = new KMSClient({ region: this.region });
    const resp = await client.send(new DecryptCommand({
      KeyId: this.keyId,
      CiphertextBlob: encryptedDek,
    }));
    const dek = Buffer.from(resp.Plaintext!);

    const decipher = createDecipheriv(DEK_ALGO, dek, iv);
    decipher.setAuthTag(authTag);
    const result = decipher.update(ct) + decipher.final('utf8');
    dek.fill(0);
    return result;
  }

  private assertConfigured(): void {
    if (!this.keyId) throw new Error('KMS not configured: set KMS_KEY_ID');
  }

  // Dynamic import so the hard dep is optional at build time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
  private async kmsClient(): Promise<any> { return import('@aws-sdk/client-kms'); }
}
