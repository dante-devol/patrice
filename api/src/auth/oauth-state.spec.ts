import { signOAuthState, verifyOAuthState } from './oauth-state';

describe('oauth-state', () => {
  const secret = 'test-session-secret-at-least-16-chars';

  it('round-trips a signed state payload', () => {
    const raw = signOAuthState(secret, { intent: 'login' });
    const parsed = verifyOAuthState(secret, raw, 60_000);
    expect(parsed.intent).toBe('login');
    expect(parsed.nonce).toHaveLength(24); // 12 random bytes, hex
    expect(typeof parsed.iat).toBe('number');
  });

  it('carries intent-specific context', () => {
    const raw = signOAuthState(secret, { intent: 'register', inviteToken: 'inv-123' });
    const parsed = verifyOAuthState(secret, raw, 60_000);
    expect(parsed.intent).toBe('register');
    expect(parsed.inviteToken).toBe('inv-123');

    const linkRaw = signOAuthState(secret, { intent: 'link', userId: 'user-9' });
    expect(verifyOAuthState(secret, linkRaw, 60_000).userId).toBe('user-9');
  });

  it('rejects a tampered payload', () => {
    const raw = signOAuthState(secret, { intent: 'login' });
    const [body, sig] = raw.split('.');
    const forged = `${Buffer.from('{"intent":"link","userId":"attacker","nonce":"x","iat":' + Date.now() + '}').toString('base64url')}.${sig}`;
    expect(() => verifyOAuthState(secret, forged, 60_000)).toThrow();
    // original body with truncated sig also fails
    expect(() => verifyOAuthState(secret, `${body}.deadbeef`, 60_000)).toThrow();
  });

  it('rejects a state signed with a different secret', () => {
    const raw = signOAuthState('other-secret-also-16-chars-long', { intent: 'login' });
    expect(() => verifyOAuthState(secret, raw, 60_000)).toThrow();
  });

  it('rejects an expired state', () => {
    const raw = signOAuthState(secret, { intent: 'login' });
    // maxAge 0 → anything older than "now" is expired
    expect(() => verifyOAuthState(secret, raw, -1)).toThrow(/expired/);
  });

  it('rejects a malformed state', () => {
    expect(() => verifyOAuthState(secret, 'not-a-valid-state', 60_000)).toThrow();
  });
});
