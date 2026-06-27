import '../../test/env';
import { AeadEnvAdapter } from './aead-env.adapter';
import type { Env } from '../config/env';

const KEY = 'a'.repeat(64); // 32-byte hex key for tests

function makeAdapter(key?: string) {
  return new AeadEnvAdapter({ INTEGRATION_TOKEN_KEY: key } as unknown as Env);
}

describe('AeadEnvAdapter', () => {
  it('canHandle returns true for aead: refs', () => {
    const a = makeAdapter(KEY);
    expect(a.canHandle('aead:abc')).toBe(true);
  });

  it('canHandle returns false for vault: and plain refs', () => {
    const a = makeAdapter(KEY);
    expect(a.canHandle('vault:/path')).toBe(false);
    expect(a.canHandle('plain-token')).toBe(false);
  });

  it('encrypt produces an aead: handle', async () => {
    const a = makeAdapter(KEY);
    const ref = await a.encrypt('Bot.my.token');
    expect(ref).toMatch(/^aead:/);
  });

  it('encrypt → decrypt round-trips correctly', async () => {
    const a = makeAdapter(KEY);
    const plaintext = 'Bot.supersecret.token.xyz';
    const ref = await a.encrypt(plaintext);
    const decrypted = await a.decrypt(ref);
    expect(decrypted).toBe(plaintext);
  });

  it('two encryptions of the same value produce different ciphertexts (random IV)', async () => {
    const a = makeAdapter(KEY);
    const ref1 = await a.encrypt('token');
    const ref2 = await a.encrypt('token');
    expect(ref1).not.toBe(ref2);
  });

  it('decrypt rejects a tampered ciphertext', async () => {
    const a = makeAdapter(KEY);
    const ref = await a.encrypt('token');
    const tampered = ref.slice(0, -4) + 'ZZZZ';
    await expect(a.decrypt(tampered)).rejects.toThrow();
  });

  it('throws on encrypt when key is absent', async () => {
    const a = makeAdapter(undefined);
    await expect(a.encrypt('token')).rejects.toThrow('INTEGRATION_TOKEN_KEY');
  });

  it('throws on decrypt when key is absent', async () => {
    const a = makeAdapter(undefined);
    await expect(a.decrypt('aead:abc')).rejects.toThrow('INTEGRATION_TOKEN_KEY');
  });

  it('rotation: re-encrypting produces a different handle that decrypts to the same value', async () => {
    const a = makeAdapter(KEY);
    const original = await a.encrypt('Bot.token');
    const rotated = await a.encrypt('Bot.token');
    expect(original).not.toBe(rotated);
    expect(await a.decrypt(rotated)).toBe('Bot.token');
  });
});
