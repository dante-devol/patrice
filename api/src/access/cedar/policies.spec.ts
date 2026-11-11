import { CedarEngine } from './engine';
import { grantToPolicies, grantToPolicy, ProjectableGrant, staticPolicies, supportsOwnScope, unitRoleId } from './policies';
import { ALL_ACTION_STRINGS } from '../actions';

/**
 * Projection-level checks for the task grants — especially the Claim
 * Eligibility AND-Composition clause, whose `has`-guarded boolean shape must both
 * parse and pass strict schema validation (validate-before-activate).
 */
describe('grantToPolicy — task scopes', () => {
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

  it('projects message:create @ own as "can see the task"', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'message:create', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.requester == principal');
    expect(policy).toContain('resource.claimants.contains(principal)');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects attachment:create @ own as "on your own message"', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'attachment:create', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.sender == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('projects task:submit @ own as "holds a seat"', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:submit', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.claimants.contains(principal)');
    expect(engine.validationErrors(policy)).toEqual([]);
  });

  it('every action that supports `own` projects to a schema-valid policy', () => {
    const own = ALL_ACTION_STRINGS.filter(supportsOwnScope);
    expect(own.length).toBeGreaterThan(10);
    for (const action of own) {
      const policy = grantToPolicy(baseGrant({ action, scopeKind: 'own' }));
      expect([action, engine.validationErrors(policy)]).toEqual([action, []]);
    }
  });

  it('projects task:review @ own as a requester-ownership clause', () => {
    const policy = grantToPolicy(
      baseGrant({ action: 'task:review', scopeKind: 'own' }),
    );
    expect(policy).toContain('resource.requester == principal');
    expect(engine.validationErrors(policy)).toEqual([]);
  });
});

describe('staticPolicies — self-review forbid', () => {
  const engine = new CedarEngine();

  it('emits a claimant-keyed task:review forbid when self-review is disabled', () => {
    const policies = staticPolicies({
      selfReviewAllowed: false,
      registeredActions: ALL_ACTION_STRINGS,
      discordGatedActions: [],
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
      discordGatedActions: [],
    });
    expect(policies.some((p) => p.includes('static_self_review_forbid'))).toBe(false);
  });
});

/**
 * Teams that serve several divisions (ADR 0020): division authority, whether from a
 * unit role assigned at the division or a division-scoped grant, reaches a team only
 * when the team lists exactly that one division. Decided on the teams' true
 * attributes, against USA[Writing], USA[Writing, Art] and USA[all].
 */
describe('team scopes — multi-division teams', () => {
  const engine = new CedarEngine();
  const NS = 'Patrice';
  const WRITING = '00000000-0000-0000-0000-0000000000a1';
  const ART = '00000000-0000-0000-0000-0000000000a2';
  const ROLE = '00000000-0000-0000-0000-000000000001';
  const ref = (type: string, id: string) => ({ __entity: { type: `${NS}::${type}`, id } });
  const team = (id: string, divisions: string[], allDivisions = false) => ({
    uid: { type: `${NS}::Team`, id },
    attrs: {
      team: ref('Team', id),
      divisions: allDivisions ? [] : divisions.map((d) => ref('Division', d)),
      allDivisions,
      divisionCount: allDivisions ? 0 : divisions.length,
      restrictClaims: false,
    },
    parents: [],
  });
  const TEAMS = {
    writingOnly: team('t-writing', [WRITING]),
    writingAndArt: team('t-writing-art', [WRITING, ART]),
    all: team('t-all', [], true),
  };

  const decide = (policy: string, parent: { type: string; id: string }, memberDivisions: string[], resource: ReturnType<typeof team>, action = 'team:update') => {
    const principal = {
      uid: { type: `${NS}::User`, id: 'u1' },
      attrs: { memberDivisions: memberDivisions.map((d) => ref('Division', d)), memberTeams: [] },
      parents: [parent],
    };
    return engine.authorize({
      principal: principal.uid,
      action: { type: `${NS}::Action`, id: action },
      resource: resource.uid,
      entities: [principal, resource, { uid: parent, attrs: {}, parents: [] }],
      policiesText: policy,
    });
  };
  const outcomes = (policy: string, parent: { type: string; id: string }, member: string[] = []) => ({
    writingOnly: decide(policy, parent, member, TEAMS.writingOnly),
    writingAndArt: decide(policy, parent, member, TEAMS.writingAndArt),
    all: decide(policy, parent, member, TEAMS.all),
  });
  const ONLY_SINGLE = { writingOnly: true, writingAndArt: false, all: false };
  const grant = (over: Partial<ProjectableGrant>): ProjectableGrant => ({
    id: 'g1',
    roleId: ROLE,
    action: 'team:update',
    effect: 'permit',
    scopeKind: 'global',
    scopeDivisionId: null,
    scopeTeamId: null,
    scopeRoleId: null,
    ...over,
  });
  const role = { type: `${NS}::Role`, id: ROLE };

  it('a unit role at Writing runs USA[Writing] only', () => {
    const [policy] = grantToPolicies(grant({ scopeKind: 'assigned' }), [{ unitType: 'division', unitId: WRITING }]);
    expect(engine.validationErrors(policy)).toEqual([]);
    const unitRole = { type: `${NS}::UnitRole`, id: unitRoleId(ROLE, { unitType: 'division', unitId: WRITING }) };
    expect(outcomes(policy, unitRole)).toEqual(ONLY_SINGLE);
  });

  it('a Writing division-scoped grant reaches USA[Writing] only', () => {
    const policy = grantToPolicy(grant({ scopeKind: 'specific_division', scopeDivisionId: WRITING }));
    expect(engine.validationErrors(policy)).toEqual([]);
    expect(outcomes(policy, role)).toEqual(ONLY_SINGLE);
  });

  it('an own_division grant reaches only single-division teams, even for members of every listed division', () => {
    const policy = grantToPolicy(grant({ scopeKind: 'own_division' }));
    expect(engine.validationErrors(policy)).toEqual([]);
    expect(outcomes(policy, role, [WRITING, ART])).toEqual(ONLY_SINGLE);
    expect(outcomes(policy, role, [ART])).toEqual({ writingOnly: false, writingAndArt: false, all: false });
  });

  it('an org-wide grant and a team-scoped grant still reach every shape', () => {
    expect(outcomes(grantToPolicy(grant({})), role)).toEqual({ writingOnly: true, writingAndArt: true, all: true });
    const teamScoped = grantToPolicy(grant({ scopeKind: 'specific_team', scopeTeamId: 't-writing-art' }));
    expect(engine.validationErrors(teamScoped)).toEqual([]);
    expect(outcomes(teamScoped, role)).toEqual({ writingOnly: false, writingAndArt: true, all: false });
  });

  it('a unit role held at a team runs that team, whatever its divisions', () => {
    const [policy] = grantToPolicies(grant({ scopeKind: 'assigned' }), [{ unitType: 'team', unitId: 't-all' }]);
    const unitRole = { type: `${NS}::UnitRole`, id: unitRoleId(ROLE, { unitType: 'team', unitId: 't-all' }) };
    expect(outcomes(policy, unitRole)).toEqual({ writingOnly: false, writingAndArt: false, all: true });
  });

  it('division-scoped grants still reach divisions and tasks', () => {
    const policy = grantToPolicy(grant({ action: 'task:read', scopeKind: 'specific_division', scopeDivisionId: WRITING }));
    const task = { uid: { type: `${NS}::Task`, id: 'task1' }, attrs: { division: ref('Division', WRITING) }, parents: [] };
    const principal = { uid: { type: `${NS}::User`, id: 'u1' }, attrs: { memberDivisions: [], memberTeams: [] }, parents: [role] };
    expect(
      engine.authorize({
        principal: principal.uid,
        action: { type: `${NS}::Action`, id: 'task:read' },
        resource: task.uid,
        entities: [principal, task, { uid: role, attrs: {}, parents: [] }],
        policiesText: policy,
      }),
    ).toBe(true);
  });
});
