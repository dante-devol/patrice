import { CedarEngine } from './engine';
import { grantToPolicy, ProjectableGrant, staticPolicies } from './policies';
import { ALL_ACTION_STRINGS } from '../actions';

/**
 * Projection-level checks for the Slice 4 task grants — especially the Claim
 * Eligibility AND-Composition clause, whose `has`-guarded boolean shape must both
 * parse and pass strict schema validation (validate-before-activate).
 */
describe('grantToPolicy — Slice 4 task scopes', () => {
  const engine = new CedarEngine();

  const baseGrant = (over: Partial<ProjectableGrant>): ProjectableGrant => ({
    id: 'g1',
    roleId: '00000000-0000-0000-0000-000000000001',
    action: 'task:create',
    effect: 'permit',
    scopeKind: 'global',
    scopeDivisionId: null,
    scopeTeamId: null,
    scopeRoleId: null,
    ...over,
  });

  it('projects task:assign @ own as the eligibility clause and it validates', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:assign', scopeKind: 'own' }),
    );
    expect(policy).toContain('memberDivisions');
    expect(policy).toContain('divisionRestrictsClaims');
    expect(engine.parseErrors(policy)).toEqual([]);
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects task:manage_claims @ own as a requester-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:manage_claims', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.requester == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects task:create @ specific_division and it validates', () => {
    const policy = grantToPolicy(
      baseGrant({
        action: 'task:create',
        scopeKind: 'specific_division',
        scopeDivisionId: '00000000-0000-0000-0000-0000000000aa',
      }),
    );
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects message:create @ own as a sender-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'message:create', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.sender == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects attachment:create @ own as an uploader-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'attachment:create', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.uploader == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects task:submit @ own as a claimant-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:submit', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.claimant == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects task:review @ own as a requester-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:review', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.requester == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });
});

describe('staticPolicies — self-review forbid (Slice 5)', () => {
  const engine = new CedarEngine();

  it('emits a claimant-keyed task:review forbid when self-review is disabled', () => {
    const policies = staticPolicies({
      selfReviewAllowed: false,
      registeredActions: ALL_ACTION_STRINGS,
    });
    const forbid = policies.find((p) => p.includes('static_self_review_forbid'));
    expect(forbid).toBeDefined();
    // Keys off the reviewed submission's claimant — never the requester (which would
    // wrongly block reviewing other claimants' work).
    expect(forbid).toContain('resource.claimant == principal');
    expect(forbid).not.toContain('resource.requester == principal');
    expect(engine.parseErrors(forbid!)).toEqual([]);
  });

  it('omits the forbid when self-review is allowed', () => {
    const policies = staticPolicies({
      selfReviewAllowed: true,
      registeredActions: ALL_ACTION_STRINGS,
    });
    expect(policies.some((p) => p.includes('static_self_review_forbid'))).toBe(false);
  });
});
