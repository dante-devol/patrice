import '../../test/env';
import { CompositeCipherAdapter } from './composite-cipher.adapter';
import { AeadEnvAdapter } from './aead-env.adapter';
import { VaultTransitAdapter } from './vault-transit.adapter';
import { KmsEnvelopeAdapter } from './kms-envelope.adapter';
import type { Env } from '../config/env';

const KEY = 'b'.repeat(64);
const noEnv = {} as unknown as Env;

function makeComposite(aeadKey?: string) {
  const aead = new AeadEnvAdapter({ INTEGRATION_TOKEN_KEY: aeadKey } as unknown as Env);
  const vault = new VaultTransitAdapter(noEnv);
  const kms = new KmsEnvelopeAdapter(noEnv);
  return new CompositeCipherAdapter(aead, vault, kms);
}

describe('CompositeCipherAdapter', () => {
  it('canHandle returns true for aead: refs', () => {
    expect(makeComposite(KEY).canHandle('aead:blob')).toBe(true);
  });

  it('canHandle returns true for vault: refs', () => {
    expect(makeComposite().canHandle('vault:v1:abc')).toBe(true);
  });

  it('canHandle returns true for kms: refs', () => {
    expect(makeComposite().canHandle('kms:arn:aws:kms:blob')).toBe(true);
  });

  it('canHandle returns false for unknown tags', () => {
    expect(makeComposite().canHandle('plain-token')).toBe(false);
  });

  it('decrypt routes aead: refs to AeadEnvAdapter', async () => {
    const composite = makeComposite(KEY);
    const ref = await composite.encrypt('my-secret');
    expect(ref).toMatch(/^aead:/);
    expect(await composite.decrypt(ref)).toBe('my-secret');
  });

  it('encrypt always delegates to AeadEnvAdapter', async () => {
    const composite = makeComposite(KEY);
    const ref = await composite.encrypt('token');
    expect(ref).toMatch(/^aead:/);
  });

  it('throws on decrypt for unknown ref tag', async () => {
    await expect(makeComposite().decrypt('unknown:blob')).rejects.toThrow('No SecretCipherPort adapter');
  });

  it('VaultTransitAdapter.canHandle matches vault: refs', () => {
    const v = new VaultTransitAdapter(noEnv);
    expect(v.canHandle('vault:v1:abc123')).toBe(true);
    expect(v.canHandle('aead:abc')).toBe(false);
  });

  it('KmsEnvelopeAdapter.canHandle matches kms: refs', () => {
    const k = new KmsEnvelopeAdapter(noEnv);
    expect(k.canHandle('kms:arn:aws:kms:us-east-1:123:key/abc')).toBe(true);
    expect(k.canHandle('aead:abc')).toBe(false);
  });

  it('VaultTransitAdapter.encrypt throws when not configured', async () => {
    const v = new VaultTransitAdapter(noEnv);
    await expect(v.encrypt('token')).rejects.toThrow('Vault not configured');
  });

  it('KmsEnvelopeAdapter.encrypt throws when not configured', async () => {
    const k = new KmsEnvelopeAdapter(noEnv);
    await expect(k.encrypt('token')).rejects.toThrow('KMS not configured');
  });
});
