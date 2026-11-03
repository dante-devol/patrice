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
 * `has`-guarded so a teamless task never dereferences `resource.team`.
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
 * Can see the task: requested it, holds a seat on it, or could claim it. A restricted
 * division therefore hides its tasks from non-members as well as blocking claims.
 */
const VISIBLE = `(resource has requester && resource.requester == principal) || (${SEATED}) || (${ELIGIBLE})`;

/** `own` conditions that aren't a plain owner attribute. */
const OWN_WHEN_BY_ACTION: Readonly<Record<string, string>> = {
  'task:read': VISIBLE,
  'message:read': VISIBLE,
  'submission:read': VISIBLE,
  'attachment:read': VISIBLE,
  'message:create': VISIBLE,
  // Claiming is *becoming* a claimant, so `own` is eligibility, not ownership.
  'task:assign': ELIGIBLE,
  'task:leave': SEATED,
  'task:submit': SEATED,
};

/** Actions whose `own` scope means "yourself" (the resource is a User). */
const OWN_SELF_ACTIONS = new Set(['user:read', 'user:update']);

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
      const when = OWN_WHEN_BY_ACTION[g.action];
      if (when) return ` when { ${when} }`;
      if (OWN_SELF_ACTIONS.has(g.action)) return ' when { resource == principal }';
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
