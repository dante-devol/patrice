import { CEDAR_NAMESPACE } from './schema';

/**
 * Projection of `grant` rows + static policies into Cedar policy **text**.
 *
 * Design note (one policy per grant, adapted to Cedar's constraints): Cedar templates can only slot `?principal` /
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
    | 'role'
    | 'assigned';
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
  /** The grant belongs to Everyone, which every user holds without a role row (ADR 0022). */
  everyone?: boolean;
  /** The grant belongs to a unit role: `assigned` and `own` are projected per unit. */
  unit?: boolean;
}

const NS = CEDAR_NAMESPACE;

/**
 * Owner relation per action for the `own` scope (the "Own Family"). The resource
 * carries an attribute naming its owner; the projector picks the right one.
 */
const OWN_ATTR_BY_ACTION: Readonly<Record<string, string>> = {
  // The requester runs their task.
  'task:update': 'requester',
  'task:retire': 'requester',
  'task:revive': 'requester',
  'task:configure_request_template': 'requester',
  'task:manage_claims': 'requester',
  'task:change_requester': 'requester',
  'task:review': 'requester',
  'task:retire_submission': 'requester',
  'task:complete': 'requester',
  // Senders and uploaders manage what they posted; attaching goes on your own message.
  'message:update': 'sender',
  'message:delete': 'sender',
  'attachment:create': 'sender',
  'attachment:delete': 'uploader',
  'session:revoke': 'owner',
};

/**
 * Claim Eligibility AND-Composition (api/CONTEXT.md): for each of division and team,
 * that unit doesn't restrict claims, OR the principal is a member of it. Each side is
 * `has`-guarded so a teamless task never dereferences `resource.team`. It is a rule,
 * not a scope: the static `static_claim_restriction` forbid applies it to every claim,
 * whatever grant permitted it (ADR 0021).
 */
const ELIGIBLE =
  '(!(resource has divisionRestrictsClaims && resource.divisionRestrictsClaims) ' +
  '|| (resource has division && principal.memberDivisions.contains(resource.division))) ' +
  '&& ' +
  '(!(resource has teamRestrictsClaims && resource.teamRestrictsClaims) ' +
  '|| (resource has team && principal.memberTeams.contains(resource.team)))';

/** Holds a seat on the task. */
const SEATED = 'resource has claimants && resource.claimants.contains(principal)';

/**
 * Involved in the task: requested it or holds a seat on it. `own` on reading and
 * commenting means only this; seeing other tasks takes a division, team or assigned
 * grant (ADR 0021).
 */
const INVOLVED = `(resource has requester && resource.requester == principal) || (${SEATED})`;

/**
 * `own` conditions that aren't a plain owner attribute. Claiming (`task:assign`) has
 * no `own`: it is about tasks that aren't yours yet.
 */
const OWN_WHEN_BY_ACTION: Readonly<Record<string, string>> = {
  'task:read': INVOLVED,
  'message:read': INVOLVED,
  'submission:read': INVOLVED,
  'attachment:read': INVOLVED,
  'message:create': INVOLVED,
  'task:leave': SEATED,
  'task:submit': SEATED,
};

/** Actions whose `own` scope means "yourself" (the resource is a User). */
const OWN_SELF_ACTIONS = new Set(['user:read', 'user:update']);

/**
 * What an `own` grant on `action` checks, for the permission editor to explain: an
 * owner relation (`requester`, `sender`, `uploader`, `owner`), `involved`, `seated`,
 * `self`, or null when `own` doesn't apply.
 */
export function ownRelation(action: string): string | null {
  if (action in OWN_ATTR_BY_ACTION) return OWN_ATTR_BY_ACTION[action];
  if (OWN_SELF_ACTIONS.has(action)) return 'self';
  const when = OWN_WHEN_BY_ACTION[action];
  if (when === INVOLVED) return 'involved';
  if (when === SEATED) return 'seated';
  return null;
}

/** Whether `own` scope means something for this action. */
export function supportsOwnScope(action: string): boolean {
  return action in OWN_ATTR_BY_ACTION || action in OWN_WHEN_BY_ACTION || OWN_SELF_ACTIONS.has(action);
}

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

/**
 * A team that division D's authority reaches: one listing exactly D and not supporting
 * every division. A multi-division or all-division team is administered only by
 * org-wide authority and by roles held at the team (ADR 0020).
 */
function singleDivisionTeamIn(division: string): string {
  return (
    `(resource has divisions && resource has allDivisions && resource has divisionCount ` +
    `&& !resource.allDivisions && resource.divisionCount == 1 && resource.divisions.contains(${division}))`
  );
}

/** The same, for any division the principal is a member of. */
const SINGLE_DIVISION_TEAM_IN_OWN =
  '(resource has divisions && resource has allDivisions && resource has divisionCount ' +
  '&& !resource.allDivisions && resource.divisionCount == 1 ' +
  '&& principal.memberDivisions.containsAll(resource.divisions))';

/** Build the Cedar `when {...}` scope condition for a grant, or '' for global. */
function scopeCondition(g: ProjectableGrant): string {
  switch (g.scopeKind) {
    case 'global':
      return '';
    case 'specific_division': {
      const d = divisionRef(g.scopeDivisionId ?? '');
      return ` when { (resource has division && resource.division == ${d}) || ${singleDivisionTeamIn(d)} }`;
    }
    case 'specific_team':
      return ` when { resource has team && resource.team == ${teamRef(
        g.scopeTeamId ?? '',
      )} }`;
    case 'own_division':
      return (
        ' when { (resource has division && principal.memberDivisions.contains(resource.division)) || ' +
        `${SINGLE_DIVISION_TEAM_IN_OWN} }`
      );
    case 'own_team':
      return ' when { resource has team && principal.memberTeams.contains(resource.team) }';
    case 'role':
      return ` when { resource has targetRole && resource.targetRole == ${roleRef(
        g.scopeRoleId ?? '',
      )} }`;
    case 'assigned':
      // Projected per unit assignment by grantToPolicies; never on its own.
      throw new Error('An assigned-scope grant is projected per unit assignment');
    case 'own':
      return ` when { ${ownCondition(g.action)} }`;
  }
}

/** What `own` checks for an action, as a Cedar expression. */
function ownCondition(action: string): string {
  const when = OWN_WHEN_BY_ACTION[action];
  if (when) return when;
  if (OWN_SELF_ACTIONS.has(action)) return 'resource == principal';
  const attr = OWN_ATTR_BY_ACTION[action];
  if (!attr) {
    throw new Error(`No own-relation mapping for action "${action}"; cannot project an 'own' grant.`);
  }
  return `resource has ${attr} && resource.${attr} == principal`;
}

/** Where a unit role is assigned: a division (covering its single-division teams) or one team. */
export interface UnitPlacement {
  unitType: 'division' | 'team';
  unitId: string;
}

/** The Cedar id of a unit role as held at one unit. */
export function unitRoleId(roleId: string, p: UnitPlacement): string {
  return `${roleId}@${p.unitType}:${p.unitId}`;
}

/** Actions that assign unit roles; through a unit role they're limited to lead-assignable roles. */
const ASSIGN_ROLE_ACTIONS = new Set(['division:assign_roles', 'team:assign_roles']);

/**
 * Project a grant to its Cedar policies. Most grants are one policy. A unit role's
 * grant (scope `assigned`, or `own` limited to the unit) becomes one policy per unit
 * where the role is assigned:
 * holders there are `in UnitRole::"<role>@<unit>"`, and the policy applies to
 * resources in that unit. Its `*:assign_roles` grants also require the target role
 * to be assignable by leads, so leads can't hand out roles admins keep for themselves.
 */
export function grantToPolicies(g: ProjectableGrant, placements: readonly UnitPlacement[] = []): string[] {
  const perUnit = g.scopeKind === 'assigned' || (g.unit === true && g.scopeKind === 'own');
  if (!perUnit) return [grantToPolicy(g)];
  // A unit role's `own` is "own, and in this unit" (ADR 0022).
  const own = g.scopeKind === 'own' ? ` && (${ownCondition(g.action)})` : '';
  return placements.map((p) => {
    const unit =
      p.unitType === 'division'
        ? `((resource has division && resource.division == ${divisionRef(p.unitId)}) || ${singleDivisionTeamIn(
            divisionRef(p.unitId),
          )})`
        : `resource has team && resource.team == ${teamRef(p.unitId)}`;
    const leads = ASSIGN_ROLE_ACTIONS.has(g.action)
      ? ' && resource has targetRoleAssignableByLeads && resource.targetRoleAssignableByLeads'
      : '';
    return [
      `@id("grant_${g.id}_${p.unitType}_${p.unitId}")`,
      `${g.effect}(`,
      `  principal in ${NS}::UnitRole::"${unitRoleId(g.roleId, p)}",`,
      `  action == ${actionRef(g.action)},`,
      `  resource`,
      `) when { (${unit})${own}${leads} };`,
    ].join('\n');
  });
}

/** Project a single grant row to one annotated Cedar policy. */
export function grantToPolicy(g: ProjectableGrant): string {
  // Everyone's grants apply to every principal; other org roles' to their holders.
  const principal = g.everyone ? 'principal' : `principal in ${roleRef(g.roleId)}`;
  const head =
    `@id("grant_${g.id}")\n` +
    `${g.effect}(\n` +
    `  ${principal},\n` +
    `  action == ${actionRef(g.action)},\n` +
    `  resource\n` +
    `)`;
  return `${head}${scopeCondition(g)};`;
}

export interface StaticPolicyOptions {
  /** When false, the self-review forbid is present. */
  selfReviewAllowed: boolean;
  /** Action strings present in the registry — gates conditional policies. */
  registeredActions: readonly string[];
  /** Task-access actions the `requireDiscordLink` gate covers. */
  discordGatedActions: readonly string[];
}

/**
 * The static policies (independent of grant rows). Lifecycle ("is it retired?") is
 * not here: aggregates refuse operations on retired entities, and Cedar decides *who*.
 */
export function staticPolicies(opts: StaticPolicyOptions): string[] {
  const policies: string[] = [];

  // Baseline self-access: a user may always see and update themselves, whatever
  // their roles, so a retired or empty role can never lock anyone out of their account.
  policies.push(
    `@id("static_baseline_self_access")
` +
      `permit(principal, action in [${actionRef('user:update')}, ${actionRef(
        'user:read',
      )}], resource) when { principal == resource };`,
  );

  // Baseline own-session control: a user may always end their own sessions (logout,
  // "sign out other devices"), with no grant required. Revoking *other* users'
  // sessions needs a `session:revoke` grant.
  policies.push(
    `@id("static_baseline_own_sessions")
` +
      `permit(principal, action == ${actionRef(
        'session:revoke',
      )}, resource) when { resource has owner && resource.owner == principal };`,
  );

  // Custom templates are open to any requester in divisions that allow them. A grant
  // of `task:compose_template` permits it anyway; a forbid still blocks both.
  if (opts.registeredActions.includes('task:compose_template')) {
    policies.push(
      `@id("static_custom_templates")
` +
        `permit(principal, action == ${actionRef(
          'task:compose_template',
        )}, resource) when { resource has allowCustomTemplates && resource.allowCustomTemplates };`,
    );
  }

  // Claim restriction: a division or team that restricts claims lets only its members
  // claim its tasks, whatever grant would otherwise permit it (ADR 0021). Putting
  // people on a task (`task:manage_claims`) isn't a claim and isn't restricted.
  if (opts.registeredActions.includes('task:assign')) {
    policies.push(
      `@id("static_claim_restriction")
` +
        `forbid(principal, action == ${actionRef('task:assign')}, resource) unless { ${ELIGIBLE} };`,
    );
  }

  // Self-review forbid: when self-review is disabled, a requester may not review a
  // submission they authored. The `task:review` resource carries `claimant` (the
  // reviewed submission's author), so the forbid fires only on their own work.
  if (!opts.selfReviewAllowed && opts.registeredActions.includes('task:review')) {
    policies.push(
      `@id("static_self_review_forbid")
` +
        `forbid(principal, action == ${actionRef(
          'task:review',
        )}, resource) when { resource has claimant && resource.claimant == principal };`,
    );
  }

  // requireDiscordLink: a principal the gate applies to (setting on, not linked to
  // every active Discord connection, not exempt) can't touch tasks. The principal
  // entity carries the computed `discordGated` flag (see AccessService).
  if (opts.discordGatedActions.length > 0) {
    policies.push(
      `@id("static_discord_gate")
` +
        `forbid(principal, action in [${opts.discordGatedActions.map(actionRef).join(', ')}], resource) ` +
        `when { principal has discordGated && principal.discordGated };`,
    );
  }

  return policies;
}
