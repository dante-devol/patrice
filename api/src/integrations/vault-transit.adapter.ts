import { Injectable, Inject, Logger } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import type { SecretCipherPort } from './secret-cipher.port';

const TAG = 'vault';

/**
 * HashiCorp Vault transit adapter for SecretCipherPort (#62).
 *
 * Handle format: `vault:<path>/<ciphertext>` where:
 *   path      = Vault transit key path (e.g. "transit/patrice/integrations")
 *   ciphertext = vault:v1:<base64> ciphertext from the transit API
 *
 * Requires:
 *   VAULT_ADDR   — Vault server URL (e.g. http://vault:8200)
 *   VAULT_TOKEN  — Vault client token (or use AppRole; extend with VAULT_ROLE_ID/SECRET_ID)
 *   VAULT_TRANSIT_KEY — transit key name (default "patrice-integration")
 *
 * The master key never touches Patrice; a stolen DB yields only ciphertext.
 */
@Injectable()
export class VaultTransitAdapter implements SecretCipherPort {
  private readonly logger = new Logger(VaultTransitAdapter.name);
  private readonly addr: string | undefined;
  private readonly token: string | undefined;
  private readonly keyName: string;

  constructor(@Inject(ENV) env: Env) {
    this.addr = env.VAULT_ADDR;
    this.token = env.VAULT_TOKEN;
    this.keyName = env.VAULT_TRANSIT_KEY ?? 'patrice-integration';
  }

  canHandle(ref: string): boolean {
    return ref.startsWith(`${TAG}:`);
  }

  async encrypt(plaintext: string): Promise<string> {
    this.assertConfigured();
    const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
    const res = await this.vaultFetch(
      `v1/transit/encrypt/${this.keyName}`,
      'POST',
      { plaintext: b64 },
    );
    const ciphertext = (res as { data: { ciphertext: string } }).data.ciphertext;
    return `${TAG}:${ciphertext}`;
  }

  async decrypt(ref: string): Promise<string> {
    this.assertConfigured();
    if (!this.canHandle(ref)) throw new Error(`VaultTransitAdapter cannot handle ref: ${ref}`);
    const ciphertext = ref.slice(TAG.length + 1);
    const res = await this.vaultFetch(
      `v1/transit/decrypt/${this.keyName}`,
      'POST',
      { ciphertext },
    );
    const b64 = (res as { data: { plaintext: string } }).data.plaintext;
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  private assertConfigured(): void {
    if (!this.addr || !this.token) {
      throw new Error('Vault not configured: set VAULT_ADDR and VAULT_TOKEN');
    }
  }

  private async vaultFetch(path: string, method: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.addr}/${path}`, {
      method,
      headers: {
        'X-Vault-Token': this.token!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Vault error ${res.status}: ${text}`);
    }
    return res.json();
  }
}
