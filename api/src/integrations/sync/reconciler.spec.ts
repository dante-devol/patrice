import { reconcile } from './reconciler';
import type { ExternalGroupMapping, UserRole, Role } from '@prisma/client';

// Minimal factories to keep tests concise.
const mapping = (overrides: Partial<ExternalGroupMapping> = {}): ExternalGroupMapping => ({
  id: 'm1',
  roleId: 'role-1',
  connectionId: 'conn-1',
  externalGroupId: 'ext-group-1',
  syncDirection: 'inbound',
  isBroken: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const userRole = (userId: string, roleId: string, source: 'manual' | 'integration' = 'integration'): UserRole => ({
  id: `ur-${userId}-${roleId}`,
  userId,
  roleId,
  source: source as UserRole['source'],
  sourceConnectionId: source === 'integration' ? 'conn-1' : null,
  grantedBy: null,
  grantedAt: new Date(),
  updatedAt: new Date(),
} as unknown as UserRole);

const role = (id = 'role-1'): Role => ({
  id,
  name: 'Test Role',
  kind: 'standalone',
  divisionId: null,
  teamId: null,
  lifecycleState: 'active',
  retiredAt: null,
  color: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Role);

const linked = (userId: string, extId: string) => ({ userId, externalUserId: extId });

describe('reconciler', () => {
  const baseInput = () => ({
    mappings: [mapping()],
    linkedUsers: [linked('user-1', 'ext-user-1')],
    externalMembership: new Map([['ext-user-1', ['ext-group-1']]]),
    knownGroupIds: new Set(['ext-group-1']),
    existingRoles: new Map<string, UserRole>(),
    roleRows: new Map([['role-1', role()]]),
  });

  describe('inbound', () => {
    it('grants Patrice role when user has external role and no Patrice role', () => {
      const result = reconcile(baseInput());
      expect(result.paOps).toHaveLength(1);
      expect(result.paOps[0]).toMatchObject({ kind: 'grant', userId: 'user-1', roleId: 'role-1' });
      expect(result.externalOps).toHaveLength(0);
    });

    it('no-op when already converged (user has both roles)', () => {
      const input = baseInput();
      input.existingRoles.set('user-1:role-1', userRole('user-1', 'role-1'));
      const result = reconcile(input);
      expect(result.paOps).toHaveLength(0);
    });

    it('revokes integration-sourced Patrice role when external role is gone', () => {
      const input = baseInput();
      input.externalMembership = new Map([['ext-user-1', []]]);
      input.existingRoles.set('user-1:role-1', userRole('user-1', 'role-1', 'integration'));
      const result = reconcile(input);
      expect(result.paOps).toHaveLength(1);
      expect(result.paOps[0]).toMatchObject({ kind: 'revoke', userId: 'user-1', roleId: 'role-1' });
    });

    it('does not revoke manually-granted Patrice role when external role is gone', () => {
      const input = baseInput();
      input.externalMembership = new Map([['ext-user-1', []]]);
      input.existingRoles.set('user-1:role-1', userRole('user-1', 'role-1', 'manual'));
      const result = reconcile(input);
      expect(result.paOps).toHaveLength(0);
    });
  });

  describe('outbound', () => {
    it('adds external role when user has Patrice role but not external', () => {
      const input = baseInput();
      input.mappings = [mapping({ syncDirection: 'outbound' })];
      input.externalMembership = new Map([['ext-user-1', []]]);
      input.existingRoles.set('user-1:role-1', userRole('user-1', 'role-1'));
      const result = reconcile(input);
      expect(result.externalOps).toHaveLength(1);
      expect(result.externalOps[0]).toMatchObject({ action: 'add', externalUserId: 'ext-user-1', externalGroupId: 'ext-group-1' });
      expect(result.paOps).toHaveLength(0);
    });

    it('removes external role when user lacks Patrice role but has external', () => {
      const input = baseInput();
      input.mappings = [mapping({ syncDirection: 'outbound' })];
      const result = reconcile(input);
      expect(result.externalOps).toHaveLength(1);
      expect(result.externalOps[0]).toMatchObject({ action: 'remove', externalUserId: 'ext-user-1' });
    });

    it('no-op when converged on outbound', () => {
      const input = baseInput();
      input.mappings = [mapping({ syncDirection: 'outbound' })];
      input.existingRoles.set('user-1:role-1', userRole('user-1', 'role-1'));
      const result = reconcile(input);
      expect(result.externalOps).toHaveLength(0);
    });
  });

  describe('broken mapping detection', () => {
    it('flags broken when external group absent and we have member data', () => {
      const input = baseInput();
      input.knownGroupIds = new Set(['other-group']);
      const result = reconcile(input);
      expect(result.brokenMappingIds).toContain('m1');
      expect(result.paOps).toHaveLength(0);
    });

    it('skips broken detection when externalMembership is empty (fetch returned nothing)', () => {
      const input = baseInput();
      input.externalMembership = new Map();
      input.knownGroupIds = new Set();
      const result = reconcile(input);
      expect(result.brokenMappingIds).toHaveLength(0);
    });

    it('skips already-broken mappings', () => {
      const input = baseInput();
      input.mappings = [mapping({ isBroken: true })];
      const result = reconcile(input);
      expect(result.paOps).toHaveLength(0);
      expect(result.brokenMappingIds).toHaveLength(0);
    });
  });

  describe('retired role', () => {
    it('skips ops when mapped role is retired', () => {
      const input = baseInput();
      const retiredRole = { ...role(), lifecycleState: 'retired' } as unknown as Role;
      input.roleRows.set('role-1', retiredRole);
      const result = reconcile(input);
      expect(result.paOps).toHaveLength(0);
    });
  });
});
