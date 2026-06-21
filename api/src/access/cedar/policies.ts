import { CEDAR_NAMESPACE } from './schema';

/**
 * Projection of `grant` rows + static policies into Cedar policy **text**.
 *
 * Design note (faithful to docs/slices/01 "template library + one link per grant",
 * adapted to Cedar's constraints): Cedar templates can only slot `?principal` /
 * `?resource` entities — not the *action* or scalar scope values. So instead of a
 * literal template-link per grant, we keep a fixed set of **per-scope-shape policy
 * generators** and emit one annotated static policy per grant. This preserves the
 * invariant the slice cares about — a small fixed shape library, exactly one
 * projected policy per grant row, rebuilt on grant change — while staying valid
 * Cedar. The `own` shape consults a static action→owner-relation map.
 */

export interface ProjectableGrant {
  id: string;
  roleId: string;
  action: string;
  effect: 'permit' | 'forbid';
  scopeKind:
    | 'global'
    | 'own'
    | 'own_division'
    | 'own_team'
    | 'specific_division'
    | 'specific_team'
    | 'role';
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
}

const NS = CEDAR_NAMESPACE;

/**
 * Owner relation per action for the `own` scope (the "Own Family"). The resource
 * carries an attribute naming its owner; the projector picks the right one. Empty
 * in Slice 1 (no own-scoped actions yet) — populated as task/message/attachment
 * actions arrive (Slices 4–5).
 */
const OWN_ATTR_BY_ACTION: Readonly<Record<string, string>> = {
  // Slice 4.1 — requester own-family (own_as_requester).
  'task:update': 'requester',
  'task:retire': 'requester',
  'task:revive': 'requester',
  'task:configure_questionnaire': 'requester',
  // Slice 4.2 — the requester manages claims / reassigns the requester.
  'task:manage_claims': 'requester',
  'task:change_requester': 'requester',
  // Slice 4.3 — sender own-family (own_as_sender) + uploader (own_as_uploader).
  'message:create': 'sender',
  'message:update': 'sender',
  'message:retire': 'sender',
  'attachment:create': 'uploader',
  'attachment:retire': 'uploader',
  'attachment:revive': 'uploader',
  // Slice 5 — submission lifecycle. submit is the claimant own-family; review /
  // retire_submission / complete are requester own-family (own_as_requester).
  'task:submit': 'claimant',
  'task:review': 'requester',
  'task:retire_submission': 'requester',
  'task:complete': 'requester',
};

/**
 * Claim Eligibility AND-Composition (api/CONTEXT.md): the `own_as_claimant` clause
 * the `task:assign` permit carries. A principal may claim iff — for each of division
 * and team — that group does NOT restrict claims, OR the principal is a member of it
 * (its inherent role, surfaced as `memberDivisions`/`memberTeams`). Each side is
 * independently `has`-guarded so the clause type-checks under strict validation and a
 * teamless task (teamRestrictsClaims=false) never dereferences `resource.team`.
 */
const CLAIM_ELIGIBILITY_WHEN =
  ' when { ' +
  '(!(resource has divisionRestrictsClaims && resource.divisionRestrictsClaims) ' +
  '|| (resource has division && principal.memberDivisions.contains(resource.division))) ' +
  '&& ' +
  '(!(resource has teamRestrictsClaims && resource.teamRestrictsClaims) ' +
  '|| (resource has team && principal.memberTeams.contains(resource.team))) }';

function roleRef(roleId: string): string {
  return `${NS}::Role::"${roleId}"`;
}
function actionRef(action: string): string {
  return `${NS}::Action::"${action}"`;
}
function divisionRef(id: string): string {
  return `${NS}::Division::"${id}"`;
}
function teamRef(id: string): string {
  return `${NS}::Team::"${id}"`;
}

/** Build the Cedar `when {...}` scope condition for a grant, or '' for global. */
function scopeCondition(g: ProjectableGrant): string {
  switch (g.scopeKind) {
    case 'global':
      return '';
    case 'specific_division':
      return ` when { resource has division && resource.division == ${divisionRef(
        g.scopeDivisionId ?? '',
      )} }`;
    case 'specific_team':
      return ` when { resource has team && resource.team == ${teamRef(
        g.scopeTeamId ?? '',
      )} }`;
    case 'own_division':
      return ' when { resource has division && principal.memberDivisions.contains(resource.division) }';
    case 'own_team':
      return ' when { resource has team && principal.memberTeams.contains(resource.team) }';
    case 'role':
      return ` when { resource has targetRole && resource.targetRole == ${roleRef(
        g.scopeRoleId ?? '',
      )} }`;
    case 'own': {
      // task:assign is the claimant own-family, but claiming is *becoming* a
      // claimant — so its `own` clause is the eligibility AND-composition, not a
      // `resource.claimant == principal` ownership check.
      if (g.action === 'task:assign') {
        return CLAIM_ELIGIBILITY_WHEN;
      }
      const attr = OWN_ATTR_BY_ACTION[g.action];
      if (!attr) {
        throw new Error(
          `No own-relation mapping for action "${g.action}"; cannot project an 'own' grant.`,
        );
      }
      return ` when { resource has ${attr} && resource.${attr} == principal }`;
    }
  }
}

/** Project a single grant row to one annotated Cedar policy. */
export function grantToPolicy(g: ProjectableGrant): string {
  const head =
    `@id("grant_${g.id}")\n` +
    `${g.effect}(\n` +
    `  principal in ${roleRef(g.roleId)},\n` +
    `  action == ${actionRef(g.action)},\n` +
    `  resource\n` +
    `)`;
  return `${head}${scopeCondition(g)};`;
}

export interface StaticPolicyOptions {
  /** When false, the self-review forbid is present (Slice 5; no-op in Slice 1). */
  selfReviewAllowed: boolean;
  /** Action strings present in the registry — gates conditional policies. */
  registeredActions: readonly string[];
}

/** The static + conditional-static policies (independent of grant rows). */
export function staticPolicies(opts: StaticPolicyOptions): string[] {
  const policies: string[] = [];

  // Retired-as-Hard-Deny: deny any action on a retired target. `has` guards the
  // heterogeneous resource model. deny-overrides-permit makes this load-bearing.
  policies.push(
    `@id("static_retired_hard_deny")\n` +
      `forbid(principal, action, resource) when { resource has retired && resource.retired };`,
  );

  // Baseline Self-Access: a user may always update themselves, independent of any
  // role — a retired/inert role can never lock a user out of their own account.
  policies.push(
    `@id("static_baseline_self_access")\n` +
      `permit(principal, action == ${actionRef(
        'user:update',
      )}, resource) when { principal == resource };`,
  );

  // Self-review forbid (Slice 5): when self-review is disabled, a requester may not
  // review a submission they authored. The `task:review` resource carries `claimant`
  // (the reviewed submission's author), so the forbid fires exactly when the reviewer
  // is that claimant — never blocking review of *other* claimants' submissions.
  if (!opts.selfReviewAllowed && opts.registeredActions.includes('task:review')) {
    policies.push(
      `@id("static_self_review_forbid")\n` +
        `forbid(principal, action == ${actionRef(
          'task:review',
        )}, resource) when { resource has claimant && resource.claimant == principal };`,
    );
  }

  return policies;
}
