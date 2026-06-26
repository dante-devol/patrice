import { SyncService } from './sync.service';

/**
 * A Patrice-side grant/revoke must enqueue a *targeted, debounced* reconcile of just
 * the affected user (the per-user singleton key), mirroring the Doorbell — not a
 * full-connection sweep that waits behind the floor.
 */
describe('SyncService.notifyUserRoleChange', () => {
  function make(opts: {
    mappings: { connectionId: string }[];
    links: { connectionId: string; externalUserId: string }[];
  }) {
    const publish = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      externalGroupMapping: { findMany: jest.fn().mockResolvedValue(opts.mappings) },
      externalIdentity: { findMany: jest.fn().mockResolvedValue(opts.links) },
    };
    const env = { INTEGRATION_SYNC_DELAY_SECONDS: 5 };
    const svc = new SyncService(
      prisma as never,
      { publish } as never,
      {} as never,
      env as never,
      'worker' as never,
    );
    return { svc, publish, prisma };
  }

  it('enqueues a per-user reconcile with the per-(connection,user) singleton key', async () => {
    const { svc, publish } = make({
      mappings: [{ connectionId: 'conn-1' }],
      links: [{ connectionId: 'conn-1', externalUserId: 'ext-1' }],
    });
    await svc.notifyUserRoleChange('user-1', 'role-1');
    expect(publish).toHaveBeenCalledTimes(1);
    const [, data, options] = publish.mock.calls[0];
    expect(data).toEqual({ connectionId: 'conn-1', externalUserId: 'ext-1' });
    expect(options).toMatchObject({ singletonKey: 'sync-conn-1-ext-1', startAfterSeconds: 5 });
  });

  it('does nothing when the user is not linked (no Discord account to push to)', async () => {
    const { svc, publish } = make({
      mappings: [{ connectionId: 'conn-1' }],
      links: [],
    });
    await svc.notifyUserRoleChange('user-1', 'role-1');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does nothing when the role is unmapped', async () => {
    const { svc, publish, prisma } = make({ mappings: [], links: [] });
    await svc.notifyUserRoleChange('user-1', 'role-1');
    expect(publish).not.toHaveBeenCalled();
    // Short-circuits before even looking up links.
    expect(prisma.externalIdentity.findMany).not.toHaveBeenCalled();
  });
});
