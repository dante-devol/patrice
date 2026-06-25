import { Injectable } from '@nestjs/common';
import type { SecretCipherPort } from './secret-cipher.port';
import { AeadEnvAdapter } from './aead-env.adapter';
import { VaultTransitAdapter } from './vault-transit.adapter';
import { KmsEnvelopeAdapter } from './kms-envelope.adapter';

/**
 * Composite SecretCipherPort that dispatches by tag (#62).
 * Registered as the SECRET_CIPHER_PORT binding; replaces the direct AeadEnvAdapter binding.
 *
 * Tag routing:
 *   aead:*   → AeadEnvAdapter (self-host default)
 *   vault:*  → VaultTransitAdapter
 *   kms:*    → KmsEnvelopeAdapter
 *
 * encrypt() always uses the AEAD adapter (self-host default); cloud adapters are
 * decrypt-only for refs written by external tooling or a future migration script.
 */
@Injectable()
export class CompositeCipherAdapter implements SecretCipherPort {
  private readonly adapters: SecretCipherPort[];

  constructor(
    private readonly aead: AeadEnvAdapter,
    private readonly vault: VaultTransitAdapter,
    private readonly kms: KmsEnvelopeAdapter,
  ) {
    this.adapters = [aead, vault, kms];
  }

  canHandle(ref: string): boolean {
    return this.adapters.some((a) => a.canHandle(ref));
  }

  async encrypt(plaintext: string): Promise<string> {
    return this.aead.encrypt(plaintext);
  }

  async decrypt(ref: string): Promise<string> {
    const adapter = this.adapters.find((a) => a.canHandle(ref));
    if (!adapter) throw new Error(`No SecretCipherPort adapter found for ref: ${ref}`);
    return adapter.decrypt(ref);
  }
}
