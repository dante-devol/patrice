import { memberIdFromEvent } from './integration-gateway.service';

describe('memberIdFromEvent (Doorbell per-user routing)', () => {
  it('extracts the user id from member add/update/remove events', () => {
    const data = { user: { id: '264835140306468865' }, roles: ['1124399965419077773'] };
    expect(memberIdFromEvent('GUILD_MEMBER_ADD', data)).toBe('264835140306468865');
    expect(memberIdFromEvent('GUILD_MEMBER_UPDATE', data)).toBe('264835140306468865');
    expect(memberIdFromEvent('GUILD_MEMBER_REMOVE', data)).toBe('264835140306468865');
  });

  it('returns null for guild-level role events (→ connection-wide sweep)', () => {
    expect(memberIdFromEvent('GUILD_ROLE_UPDATE', { role: { id: 'r1' } })).toBeNull();
    expect(memberIdFromEvent('GUILD_ROLE_CREATE', { role: { id: 'r1' } })).toBeNull();
    expect(memberIdFromEvent('GUILD_ROLE_DELETE', { role_id: 'r1' })).toBeNull();
  });

  it('returns null on a malformed member event rather than throwing', () => {
    expect(memberIdFromEvent('GUILD_MEMBER_UPDATE', null)).toBeNull();
    expect(memberIdFromEvent('GUILD_MEMBER_UPDATE', {})).toBeNull();
    expect(memberIdFromEvent('GUILD_MEMBER_UPDATE', { user: {} })).toBeNull();
  });
});
