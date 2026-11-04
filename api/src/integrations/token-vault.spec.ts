import { TokenVault } from './token-vault';
import type { Env } from '../config/env';

const vault = (key?: string) => new TokenVault({ INTEGRATION_TOKEN_KEY: key } as unknown as Env);

describe('TokenVault', () => {
  it('refuses to exist without a key: there is no plaintext fallback', () => {
    expect(() => vault(undefined)).toThrow(/INTEGRATION_TOKEN_KEY/);
  });

  it('round-trips, with a fresh IV each time', () => {
    const v = vault('a'.repeat(64));
    const a = v.encrypt('Bot.secret');
    const b = v.encrypt('Bot.secret');
    expect(a).toMatch(/^aead:/);
    expect(a).not.toBe(b);
    expect(v.decrypt(a)).toBe('Bot.secret');
  });

  it('a handle sealed under another key does not open', () => {
    const sealed = vault('a'.repeat(64)).encrypt('Bot.secret');
    expect(() => vault('b'.repeat(64)).decrypt(sealed)).toThrow();
  });

  it('only aead handles are handles', () => {
    expect(TokenVault.isHandle('aead:xyz')).toBe(true);
    expect(TokenVault.isHandle('vault:/path')).toBe(false);
    expect(TokenVault.isHandle(null)).toBe(false);
  });
});
