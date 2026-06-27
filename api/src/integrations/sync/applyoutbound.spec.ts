import { DiscordAdapter } from './discord.adapter';
import type { DiscordRestClient } from './discord-rest.client';
import type { ExternalRoleOp } from './integration-sync.port';

/**
 * applyOutbound surfaces *why* a push failed (the gap that made a 403 hierarchy
 * refusal invisible) and reports which ops succeeded.
 */
describe('DiscordAdapter.applyOutbound', () => {
  const conn = {
    id: 'conn-1',
    organizationId: 'org-1',
    externalWorkspaceId: 'guild-1',
    config: { botToken: 'Bot.token' },
    credentialsRef: null,
  } as never;

  const addOp: ExternalRoleOp = { externalUserId: 'u1', externalGroupId: 'g1', action: 'add' };

  function makeAdapter(rest: Partial<DiscordRestClient>) {
    const prisma = { integrationConnection: { update: jest.fn() } };
    const activity = { logActivity: jest.fn() };
    const cipher = { canHandle: () => false };
    return new DiscordAdapter(
      prisma as never,
      activity as never,
      {} as never,
      cipher as never,
      rest as DiscordRestClient,
      {} as never, // NotificationsService — unused by applyOutbound
      {} as never, // AdministrabilityService — unused by applyOutbound
    );
  }

  it('reports a human-readable reason + flags the group broken on 403', async () => {
    const adapter = makeAdapter({
      addMemberRole: jest.fn().mockResolvedValue({ ok: false, status: 403, body: null }),
    });
    const result = await adapter.applyOutbound(conn, [addOp]);
    expect(result.appliedOps).toHaveLength(0);
    expect(result.brokenGroupIds).toEqual(['g1']);
    expect(result.failReason).toBe('permission');
    expect(result.lastError).toMatch(/Manage Roles/i);
    // Humanized for non-developers — no HTTP status codes leak into the message.
    expect(result.lastError).not.toMatch(/403/);
  });

  it('records the successful op and no error on 204', async () => {
    const adapter = makeAdapter({
      addMemberRole: jest.fn().mockResolvedValue({ ok: true, status: 204, body: null }),
    });
    const result = await adapter.applyOutbound(conn, [addOp]);
    expect(result.appliedOps).toEqual([addOp]);
    expect(result.brokenGroupIds).toHaveLength(0);
    expect(result.lastError).toBeUndefined();
  });

  it('reports a 404 distinctly (role/member gone)', async () => {
    const adapter = makeAdapter({
      addMemberRole: jest.fn().mockResolvedValue({ ok: false, status: 404, body: null }),
    });
    const result = await adapter.applyOutbound(conn, [addOp]);
    expect(result.brokenGroupIds).toEqual(['g1']);
    expect(result.failReason).toBe('not_found');
    expect(result.lastError).toMatch(/no longer exists/i);
    expect(result.lastError).not.toMatch(/404/);
  });
});
