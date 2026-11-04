import { Holding, ReconcileInput, SyncMapping, holdingKey, reconcile } from './reconciler';

const ROLE = { kind: 'role', id: 'role-1' } as const;

const mapping = (overrides: Partial<SyncMapping> = {}): SyncMapping => ({
  id: 'm1',
  target: ROLE,
  externalGroupId: 'g1',
  syncDirection: 'inbound',
  conflictWinner: 'patrice',
  isBroken: false,
  ...overrides,
});

const held = (source: Holding['source'] = 'integration', since = new Date('2026-01-01')): Holding => ({ source, since });

/** One linked user (u1 ↔ ext1), with or without the external group and the role. */
function input(opts: {
  mapping?: Partial<SyncMapping>;
  external?: boolean;
  holding?: Holding;
  baseline?: boolean | 'cold';
  externalChangedAt?: Date;
}): ReconcileInput {
  const holdings = new Map<string, Holding>();
  if (opts.holding) holdings.set(holdingKey('u1', opts.mapping?.target ?? ROLE), opts.holding);
  return {
    mappings: [mapping(opts.mapping)],
    linkedUsers: [{ userId: 'u1', externalUserId: 'ext1' }],
    externalMembership: new Map([['ext1', opts.external ? ['g1'] : []], ['other', ['g1']]]),
    knownGroupIds: new Set(['g1']),
    holdings,
    inactiveTargets: new Set(),
    baseline: opts.baseline === 'cold' || opts.baseline === undefined ? undefined : new Set(opts.baseline ? ['ext1:g1'] : []),
    externalChangedAt: opts.externalChangedAt ? new Map([['ext1:g1', opts.externalChangedAt]]) : undefined,
  };
}

describe('reconcile', () => {
  describe('inbound', () => {
    it('grants what the provider has', () => {
      expect(reconcile(input({ external: true })).patriceOps).toEqual([
        expect.objectContaining({ kind: 'grant', userId: 'u1', target: ROLE }),
      ]);
    });

    it('revokes only what sync itself granted', () => {
      expect(reconcile(input({ holding: held('integration') })).patriceOps.map((o) => o.kind)).toEqual(['revoke']);
      expect(reconcile(input({ holding: held('patrice') })).patriceOps).toEqual([]);
    });

    it('is a no-op once converged', () => {
      const out = reconcile(input({ external: true, holding: held() }));
      expect(out.patriceOps).toEqual([]);
      expect(out.externalOps).toEqual([]);
    });
  });

  describe('outbound', () => {
    const outbound = { syncDirection: 'outbound' } as const;
    it('pushes adds and removes to match Patrice', () => {
      expect(reconcile(input({ mapping: outbound, holding: held('patrice') })).externalOps).toEqual([
        { externalUserId: 'ext1', externalGroupId: 'g1', action: 'add' },
      ]);
      expect(reconcile(input({ mapping: outbound, external: true })).externalOps.map((o) => o.action)).toEqual(['remove']);
    });
  });

  describe('bidirectional', () => {
    const bi = { syncDirection: 'bidirectional' } as const;

    it('follows the provider when only it moved', () => {
      const out = reconcile(input({ mapping: bi, external: true, baseline: false }));
      expect(out.patriceOps.map((o) => o.kind)).toEqual(['grant']);
      expect(out.baselineEdges).toEqual([expect.objectContaining({ present: true })]);
      expect(out.baselineEdges[0].dependsOn).toBeUndefined();
    });

    it('follows Patrice when only it moved', () => {
      const out = reconcile(input({ mapping: bi, external: true, baseline: true }));
      expect(out.externalOps.map((o) => o.action)).toEqual(['remove']);
    });

    it('records a pushed grant as present, pending the push (D9)', () => {
      // Granted in Patrice, absent on Discord, baseline absent: Patrice moved.
      const out = reconcile(input({ mapping: bi, holding: held('patrice'), baseline: false }));
      const add = { externalUserId: 'ext1', externalGroupId: 'g1', action: 'add' };
      expect(out.externalOps).toEqual([add]);
      expect(out.baselineEdges).toEqual([expect.objectContaining({ present: true, dependsOn: add })]);
    });

    it('then, after a revoke in Patrice, removes it from the provider instead of re-granting (D9)', () => {
      // The push landed and the baseline says present; now Patrice revoked it.
      const out = reconcile(input({ mapping: bi, external: true, baseline: true }));
      expect(out.patriceOps).toEqual([]);
      expect(out.externalOps.map((o) => o.action)).toEqual(['remove']);
    });

    it('re-asserts a native grant the provider dropped', () => {
      const out = reconcile(input({ mapping: bi, holding: held('patrice'), baseline: true }));
      expect(out.patriceOps).toEqual([]);
      expect(out.externalOps.map((o) => o.action)).toEqual(['add']);
    });

    it('breaks a cold conflict by the later change when both times are known', () => {
      const patriceAt = new Date('2026-01-01');
      const later = reconcile(
        input({ mapping: bi, holding: held('integration', patriceAt), baseline: 'cold', externalChangedAt: new Date('2026-02-01') }),
      );
      expect(later.patriceOps.map((o) => o.kind)).toEqual(['revoke']);
      const earlier = reconcile(
        input({ mapping: bi, holding: held('integration', patriceAt), baseline: 'cold', externalChangedAt: new Date('2025-12-01') }),
      );
      expect(earlier.externalOps.map((o) => o.action)).toEqual(['add']);
    });

    it("otherwise falls back to the mapping's conflict winner", () => {
      const patriceWins = reconcile(input({ mapping: bi, external: true, baseline: 'cold' }));
      expect(patriceWins.externalOps.map((o) => o.action)).toEqual(['remove']);
      const externalWins = reconcile(input({ mapping: { ...bi, conflictWinner: 'external' }, external: true, baseline: 'cold' }));
      expect(externalWins.patriceOps.map((o) => o.kind)).toEqual(['grant']);
    });
  });

  it('maps memberships the same way as roles', () => {
    const team = { kind: 'team', id: 'team-1' } as const;
    const out = reconcile(input({ mapping: { target: team }, external: true }));
    expect(out.patriceOps).toEqual([expect.objectContaining({ kind: 'grant', target: team })]);
  });

  it('flags a mapping whose group the provider no longer has', () => {
    const i = input({ external: true });
    i.knownGroupIds = new Set();
    expect(reconcile(i).brokenMappingIds).toEqual(['m1']);
  });

  it('leaves retired targets alone', () => {
    const i = input({ external: true });
    i.inactiveTargets = new Set(['role:role-1']);
    expect(reconcile(i).patriceOps).toEqual([]);
  });
});
