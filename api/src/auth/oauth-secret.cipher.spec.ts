import { encryptOAuthSecret, decryptOAuthSecret, isOAuthSecretHandle } from './oauth-secret.cipher';

describe('oauth-secret.cipher', () => {
  const secret = 'session-secret-at-least-16-chars-long';

  it('round-trips a client secret', () => {
    const handle = encryptOAuthSecret(secret, 'super-secret-discord-value');
    expect(isOAuthSecretHandle(handle)).toBe(true);
    expect(handle.startsWith('oauthsec:')).toBe(true);
    expect(handle).not.toContain('super-secret-discord-value');
    expect(decryptOAuthSecret(secret, handle)).toBe('super-secret-discord-value');
  });

  it('produces a fresh IV each time (ciphertexts differ)', () => {
    const a = encryptOAuthSecret(secret, 'same-value');
    const b = encryptOAuthSecret(secret, 'same-value');
    expect(a).not.toBe(b);
    expect(decryptOAuthSecret(secret, a)).toBe('same-value');
    expect(decryptOAuthSecret(secret, b)).toBe('same-value');
  });

  it('fails to decrypt with a different SESSION_SECRET (e.g. after rotation)', () => {
    const handle = encryptOAuthSecret(secret, 'value');
    expect(() => decryptOAuthSecret('a-different-session-secret-value', handle)).toThrow();
  });

  it('rejects a tampered handle (GCM auth tag)', () => {
    const handle = encryptOAuthSecret(secret, 'value');
    const tampered = handle.slice(0, -2) + (handle.endsWith('A') ? 'B' : 'A');
    expect(() => decryptOAuthSecret(secret, tampered)).toThrow();
  });

  it('rejects a non-handle string', () => {
    expect(isOAuthSecretHandle('plain')).toBe(false);
    expect(() => decryptOAuthSecret(secret, 'plain')).toThrow();
  });
});
