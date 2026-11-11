import { ActionInfo, ScopeKind } from '../../core/api.types';

/**
 * Plain-language names and descriptions for the permission editor. The action
 * vocabulary is closed (api `access/actions.ts`), so every action gets a name and a
 * one- or two-sentence description here; an unknown one falls back to a tidied code
 * name rather than breaking the editor.
 */
interface ActionText {
  name: string;
  description: string;
}

const ACTIONS: Record<string, ActionText> = {
  // ── Tasks ───────────────────────────────────────────────────────────────
  'task:read': {
    name: 'See tasks',
    description: 'Find a task in lists and open it: its details, status, requester and claimants.',
  },
  'task:create': {
    name: 'Request tasks',
    description: 'Create a new task in a division, using one of its request templates.',
  },
  'task:compose_template': {
    name: 'Write custom questions',
    description:
      "Give a new task its own questions instead of one of the division's request templates. " +
      'Divisions that allow custom templates let anyone do this. Also needs Request tasks.',
  },
  'task:update': {
    name: 'Edit tasks',
    description: "Change a task's name and description.",
  },
  'task:configure_request_template': {
    name: "Edit a task's questions",
    description: 'Change the questions a task asks when work is submitted. Locked once a submission is live.',
  },
  'task:assign': {
    name: 'Claim tasks',
    description:
      'Take an open seat on a task to work on it. A division or team that restricts claims ' +
      'only lets its own members claim, whatever the scope here.',
  },
  'task:leave': {
    name: 'Leave tasks',
    description: 'Give up a seat on a task, opening it for someone else.',
  },
  'task:submit': {
    name: 'Submit work',
    description: 'Hand in work on a task the person holds a seat on.',
  },
  'submission:read': {
    name: 'See submissions',
    description: 'See the work handed in on a task, and how it was reviewed.',
  },
  'task:review': {
    name: 'Review submissions',
    description: 'Approve a submission, or return it with a request for changes.',
  },
  'task:retire_submission': {
    name: 'Retire submissions',
    description: 'Withdraw a submission, with a reason. The claimant loses their seat, which opens for anyone.',
  },
  'task:complete': {
    name: 'Complete tasks',
    description:
      'Mark a task done for good. Claims close, and any submissions still outstanding are no longer needed.',
  },
  'task:manage_claims': {
    name: 'Manage claims',
    description: 'Change how many seats a task has, open or close it to new claims, and take people off it.',
  },
  'task:change_requester': {
    name: 'Change the requester',
    description: 'Hand a task over to someone else, who then runs it as its requester.',
  },
  'task:retire': {
    name: 'Retire tasks',
    description: 'Take a task out of use. It can be revived until the grace period ends.',
  },
  'task:revive': {
    name: 'Revive tasks',
    description: 'Bring back a retired task before its grace period ends.',
  },
  'task:bypass_discord_gate': {
    name: 'Skip the Discord requirement',
    description:
      'Use tasks without a linked Discord account, when the settings require one. Has no effect otherwise.',
  },

  // ── Comments and files ──────────────────────────────────────────────────
  'message:read': {
    name: 'Read comments',
    description: "Read a task's comment thread.",
  },
  'message:create': {
    name: 'Post comments',
    description: "Write in a task's comment thread.",
  },
  'message:update': {
    name: 'Edit comments',
    description: 'Change the text of a comment after it was posted.',
  },
  'message:delete': {
    name: 'Delete comments',
    description: "Remove a comment from a task's thread for good. A record of the deletion is kept.",
  },
  'attachment:read': {
    name: 'See files',
    description: 'Open and download the files attached to a task.',
  },
  'attachment:create': {
    name: 'Attach files',
    description: 'Add files to a comment.',
  },
  'attachment:delete': {
    name: 'Delete files',
    description: 'Remove an attached file for good. A record of the deletion is kept.',
  },

  // ── People ──────────────────────────────────────────────────────────────
  'user:read': {
    name: 'See people',
    description: 'See who is in the organization, with their names. Everyone can always see themselves.',
  },
  'user:update': {
    name: 'Edit people',
    description: "Change a person's display name. Everyone can always edit their own.",
  },
  'user:deactivate': {
    name: 'Deactivate people',
    description: 'Stop a person signing in, keeping everything they did. Reversible at any time.',
  },
  'user:reactivate': {
    name: 'Reactivate people',
    description: 'Let a deactivated person sign in again.',
  },
  'user:retire': {
    name: 'Retire people',
    description: 'Remove a person from the organization. They can be revived until the grace period ends.',
  },
  'user:revive': {
    name: 'Revive people',
    description: 'Bring back a retired person before their grace period ends.',
  },
  'user:grant_role': {
    name: 'Give roles',
    description: 'Give someone an org role. Scope it to one role to limit which role can be handed out.',
  },
  'user:revoke_role': {
    name: 'Take roles away',
    description: 'Remove an org role from someone. Scope it to one role to limit which role can be removed.',
  },
  'session:revoke': {
    name: 'Sign people out',
    description: "End someone's signed-in sessions. Everyone can always sign themselves out.",
  },
  'invite:create': {
    name: 'Invite people',
    description: 'Create invitation links, including the roles new people start with.',
  },
  'invite:retire': {
    name: 'Withdraw invitations',
    description: 'Cancel an invitation link so it can no longer be used.',
  },

  // ── Divisions and teams ─────────────────────────────────────────────────
  'division:read': {
    name: 'See divisions',
    description: 'See a division, its settings and its members.',
  },
  'division:create': {
    name: 'Create divisions',
    description: 'Add a new division to the organization.',
  },
  'division:update': {
    name: 'Edit divisions',
    description:
      "Change a division's name and settings: default seats, whether claims are restricted to " +
      'members, and whether custom questions are allowed.',
  },
  'division:retire': {
    name: 'Retire divisions',
    description:
      'Take a division out of use. Not allowed while an active team serves only that division. ' +
      'It can be revived until the grace period ends.',
  },
  'division:revive': {
    name: 'Revive divisions',
    description: 'Bring back a retired division before its grace period ends.',
  },
  'division:manage_members': {
    name: 'Manage division members',
    description: 'Add people to a division, or remove them.',
  },
  'division:assign_roles': {
    name: 'Appoint at divisions',
    description:
      'Give or take away unit roles, such as Project lead, at a division. Someone appointing through ' +
      'a unit role can only hand out roles marked assignable by leads.',
  },
  'request_template:read': {
    name: 'See request templates',
    description: 'See the sets of questions a division offers when someone requests a task.',
  },
  'request_template:create': {
    name: 'Create request templates',
    description: 'Add a new set of questions to a division.',
  },
  'request_template:update': {
    name: 'Edit request templates',
    description: "Change a division's request templates. Tasks already requested keep their own copy.",
  },
  'request_template:delete': {
    name: 'Delete request templates',
    description: "Remove a division's request template. Tasks already requested keep their own copy.",
  },
  'team:read': {
    name: 'See teams',
    description: 'See a team, the divisions it serves and its members.',
  },
  'team:create': {
    name: 'Create teams',
    description:
      'Add a new team. Scoped to a division, it only allows teams that serve just that one division.',
  },
  'team:update': {
    name: 'Edit teams',
    description:
      "Change a team's name, the divisions it serves and whether claims are restricted to members.",
  },
  'team:retire': {
    name: 'Retire teams',
    description: 'Take a team out of use. It can be revived until the grace period ends.',
  },
  'team:revive': {
    name: 'Revive teams',
    description: 'Bring back a retired team before its grace period ends.',
  },
  'team:manage_members': {
    name: 'Manage team members',
    description: 'Add people to a team, or remove them.',
  },
  'team:assign_roles': {
    name: 'Appoint at teams',
    description:
      'Give or take away unit roles, such as Project lead, at a team. Someone appointing through ' +
      'a unit role can only hand out roles marked assignable by leads.',
  },

  // ── Governance ──────────────────────────────────────────────────────────
  'role:read': {
    name: 'See roles',
    description: 'See the roles that exist and what each one can do.',
  },
  'role:create': {
    name: 'Create roles',
    description: 'Add a new org or unit role.',
  },
  'role:update': {
    name: 'Edit roles',
    description: "Rename a role, or change whether leads may assign it.",
  },
  'role:retire': {
    name: 'Retire roles',
    description: 'Take a role out of use, so its permissions stop applying. It can be revived until the grace period ends.',
  },
  'role:revive': {
    name: 'Revive roles',
    description: 'Bring back a retired role before its grace period ends.',
  },
  'grant:create': {
    name: 'Add permissions',
    description: 'Give a role a new permission in this editor.',
  },
  'grant:update': {
    name: 'Change permissions',
    description: "Change the scope of a permission a role already has.",
  },
  'grant:delete': {
    name: 'Remove permissions',
    description: 'Take a permission away from a role.',
  },

  // ── Settings and integrations ───────────────────────────────────────────
  'config:update': {
    name: 'Change settings',
    description: 'Change organization-wide settings, such as sign-in rules, session lengths and the grace period.',
  },
  'job:read': {
    name: 'See failed jobs',
    description: 'See background jobs that failed after every retry.',
  },
  'integration:create': {
    name: 'Connect integrations',
    description: 'Connect an outside service, such as a Discord server.',
  },
  'integration:update': {
    name: 'Edit integrations',
    description: "Change an integration's settings and how its groups map to roles and memberships.",
  },
  'integration:retire': {
    name: 'Retire integrations',
    description: 'Disconnect an integration. It can be revived until the grace period ends.',
  },
  'integration:revive': {
    name: 'Revive integrations',
    description: 'Reconnect a retired integration before its grace period ends.',
  },
};

/** `team:manage_members` → "Team manage members", for an action this file doesn't know. */
function fallbackName(action: string): string {
  const words = action.replace(/[:_]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actionLabel(action: string): string {
  return ACTIONS[action]?.name ?? fallbackName(action);
}

export function actionDescription(action: string): string {
  return ACTIONS[action]?.description ?? `The ${action} permission.`;
}

/** Resource groups, in display order, keyed by the action's `resource:` prefix. */
export const ACTION_GROUPS: { name: string; prefixes: string[] }[] = [
  { name: 'Tasks', prefixes: ['task', 'submission'] },
  { name: 'Comments and files', prefixes: ['message', 'attachment'] },
  { name: 'People', prefixes: ['user', 'session', 'invite'] },
  { name: 'Divisions and teams', prefixes: ['division', 'team', 'request_template'] },
  { name: 'Roles and permissions', prefixes: ['role', 'grant'] },
  { name: 'Settings and integrations', prefixes: ['config', 'job', 'integration'] },
];

/** Group catalogue entries by resource, keeping catalogue order inside each group. */
export function groupActions(catalog: ActionInfo[]): { name: string; actions: ActionInfo[] }[] {
  const prefix = (a: ActionInfo) => a.action.split(':')[0];
  const known = new Set(ACTION_GROUPS.flatMap((g) => g.prefixes));
  const groups = ACTION_GROUPS.map((g) => ({
    name: g.name,
    actions: catalog.filter((a) => g.prefixes.includes(prefix(a))),
  }));
  const other = catalog.filter((a) => !known.has(prefix(a)));
  if (other.length > 0) groups.push({ name: 'Other', actions: other });
  return groups.filter((g) => g.actions.length > 0);
}

// ── Scopes ────────────────────────────────────────────────────────────────

/** The "Not granted" choice in every scope picker. */
export const NOT_GRANTED = {
  name: 'Not granted',
  description: "This role can't do this. Pick a scope to grant it.",
};

/** `own`, named and explained by the relation the API says it checks. */
const OWN: Record<string, ActionText> = {
  requester: { name: 'Tasks they requested', description: 'Only tasks the person requested.' },
  involved: {
    name: "Tasks they're part of",
    description: 'Only tasks the person requested or holds a seat on.',
  },
  seated: { name: 'Tasks they hold a seat on', description: 'Only tasks the person holds a seat on right now.' },
  sender: { name: 'Their own comments', description: 'Only comments the person wrote.' },
  uploader: { name: 'Files they uploaded', description: 'Only files the person uploaded.' },
  owner: { name: 'Their own sessions', description: "Only the person's own sessions." },
  self: { name: 'Themselves', description: 'Only the person themselves.' },
};

/** Attaching a file goes on a comment, so its `sender` relation reads differently. */
const OWN_BY_ACTION: Record<string, ActionText> = {
  'attachment:create': { name: 'On their own comments', description: 'Only on comments the person wrote.' },
};

/**
 * What a scope reaches, as a phrase that completes "Only … in a division": "tasks",
 * "comments on tasks", or "teams". Reads of a task's parts target the task itself.
 */
function things(info: ActionInfo): string {
  switch (info.action) {
    case 'message:read':
    case 'message:create':
      return 'comments on tasks';
    case 'submission:read':
    case 'task:submit':
      return 'submissions on tasks';
    case 'attachment:read':
      return 'files on tasks';
    case 'task:assign':
      return 'tasks';
  }
  switch (info.resourceType) {
    case 'Task':
      return 'tasks';
    case 'Message':
      return 'comments on tasks';
    case 'Attachment':
      return 'files on tasks';
    case 'Team':
      return 'teams';
    case 'Division':
      return 'divisions';
    case 'User':
      return 'people';
    case 'Role':
      return 'roles';
    case 'Session':
      return 'sessions';
    default:
      return 'things';
  }
}

/**
 * The scope's name in the picker. A global-only action is a plain on/off grant
 * ("Granted"); `own` is named by what it checks.
 */
export function scopeLabel(scope: ScopeKind, info: ActionInfo): string {
  switch (scope) {
    case 'global':
      return info.scopes.length === 1 ? 'Granted' : 'Everywhere';
    case 'own':
      return (OWN_BY_ACTION[info.action] ?? OWN[info.own ?? ''])?.name ?? 'Their own';
    case 'own_division':
      return 'Their divisions';
    case 'own_team':
      return 'Their teams';
    case 'specific_division':
      return 'One division…';
    case 'specific_team':
      return 'One team…';
    case 'role':
      return 'One role…';
    case 'assigned':
      return 'Where they hold this role';
  }
}

/**
 * The scope's description: one or two sentences on exactly what the grant lets the
 * person do. `target` names the picked division, team or role when there is one.
 */
export function scopeHint(scope: ScopeKind, info: ActionInfo, target?: string): string {
  const what = things(info);
  const onDivision = info.resourceType === 'Division';
  const onTeam = info.resourceType === 'Team';
  switch (scope) {
    case 'global':
      return info.scopes.length === 1
        ? 'Anyone with this role can do this.'
        : `All ${what} in the organization, whatever their division or team.`;
    case 'own':
      return (OWN_BY_ACTION[info.action] ?? OWN[info.own ?? ''])?.description ?? `Only ${what} the person owns.`;
    case 'own_division':
      if (onTeam) return 'Only teams that serve just one division, which the person is a member of.';
      if (onDivision && !info.action.startsWith('division:')) return 'Only in divisions the person is a member of.';
      if (onDivision) return 'Only divisions the person is a member of.';
      return `Only ${what} in divisions the person is a member of.`;
    case 'own_team':
      if (onTeam) return 'Only teams the person is a member of.';
      return `Only ${what} in teams the person is a member of.`;
    case 'specific_division': {
      const d = target ?? 'the division you pick';
      if (onTeam) return `Only teams that serve just ${d}.`;
      if (onDivision && !info.action.startsWith('division:')) return `Only in ${d}, whether or not the person is a member.`;
      if (onDivision) return `Only ${d}, whether or not the person is a member.`;
      return `Only ${what} in ${d}, whether or not the person is a member.`;
    }
    case 'specific_team': {
      const t = target ?? 'the team you pick';
      if (onTeam) return `Only ${t}, whether or not the person is a member.`;
      return `Only ${what} in ${t}, whether or not the person is a member.`;
    }
    case 'role':
      return `Only when the role being given or taken away is ${target ?? 'the one you pick'}.`;
    case 'assigned':
      return (
        `Only ${what} in the divisions and teams where the person holds this role. ` +
        'Held at a division, it also covers teams that serve only that division.'
      );
  }
}

/** Scopes that need a second picker (division, team or role). */
export function isTargeted(scope: ScopeKind): boolean {
  return scope === 'specific_division' || scope === 'specific_team' || scope === 'role';
}
