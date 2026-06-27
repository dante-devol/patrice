import { DiscordRestClient } from './discord-rest.client';

function makeClient() {
  return new DiscordRestClient();
}

function mockFetch(responses: { status: number; headers?: Record<string, string>; body?: unknown }[]) {
  let i = 0;
  globalThis.fetch = jest.fn().mockImplementation(() => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return Promise.resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: {
        get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null,
      },
      json: () => Promise.resolve(r.body ?? null),
      text: () => Promise.resolve(String(r.body ?? '')),
    });
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DiscordRestClient', () => {
  it('adds a member role (PUT 204)', async () => {
    mockFetch([{ status: 204 }]);
    const client = makeClient();
    const result = await client.addMemberRole('guild-1', 'user-1', 'role-1', 'Bot.token');
    expect(result.status).toBe(204);
    expect(result.ok).toBe(true);
  });

  it('removes a member role (DELETE 204)', async () => {
    mockFetch([{ status: 204 }]);
    const client = makeClient();
    const result = await client.removeMemberRole('guild-1', 'user-1', 'role-1', 'Bot.token');
    expect(result.status).toBe(204);
  });

  it('retries on 429 and eventually succeeds', async () => {
    mockFetch([
      {
        status: 429,
        headers: { 'x-ratelimit-global': 'false', 'retry-after': '0.001' },
        body: { message: 'rate limited', retry_after: 0.001 },
      },
      { status: 204 },
    ]);
    const client = makeClient();
    const result = await client.addMemberRole('guild-1', 'user-1', 'role-1', 'Bot.token');
    expect(result.status).toBe(204);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns 429 after exhausting retries', async () => {
    mockFetch([
      { status: 429, headers: { 'retry-after': '0.001' }, body: null },
    ]);
    const client = makeClient();
    const result = await client.fetch({
      method: 'PUT',
      path: '/guilds/1/members/2/roles/3',
      botToken: 'Bot.token',
    }, 0);
    expect(result.status).toBe(429);
  });

  it('sends X-Audit-Log-Reason header when reason provided', async () => {
    mockFetch([{ status: 204 }]);
    const client = makeClient();
    await client.addMemberRole('guild-1', 'user-1', 'role-1', 'Bot.token', 'Admin Role');
    const call = (globalThis.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((call[1].headers as Record<string, string>)['X-Audit-Log-Reason']).toContain('Admin Role');
  });

  it('returns 403 result without retrying', async () => {
    mockFetch([{ status: 403, body: { message: 'Missing Permissions' } }]);
    const client = makeClient();
    const result = await client.addMemberRole('guild-1', 'user-1', 'role-1', 'Bot.token');
    expect(result.status).toBe(403);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('updates per-route bucket from response headers', async () => {
    const resetAt = (Date.now() / 1000 + 1).toString();
    mockFetch([
      {
        status: 204,
        headers: { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': resetAt },
      },
    ]);
    const client = makeClient();
    await client.fetch({ method: 'PUT', path: '/guilds/1/members/2/roles/3', botToken: 'Bot' });
    // Second call should still work (remaining=4, not exhausted)
    mockFetch([{ status: 204 }]);
    const result = await client.fetch({ method: 'PUT', path: '/guilds/1/members/2/roles/3', botToken: 'Bot' });
    expect(result.status).toBe(204);
  });
});
