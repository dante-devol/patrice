import { ActionInfo, ScopeKind } from '../../core/api.types';

/**
 * Plain-language names for the permission editor. The action vocabulary is closed
 * (api `access/actions.ts`), so every action gets a human name here; an unknown one
 * falls back to its code name rather than breaking the editor.
 */
const ACTION_LABELS: Record<string, string> = {
  'task:create': 'Create tasks',
  'task:update': 'Edit tasks',
  'task:retire': 'Retire tasks',
  'task:revive': 'Revive tasks',
  'task:assign': 'Claim tasks',
  'task:submit': 'Submit work',
  'task:review': 'Review submissions',
  'task:retire_submission': 'Retire submissions',
  'task:complete': 'Mark tasks complete',
  'task:configure_request_template': 'Edit request templates',
  'task:manage_claims': 'Manage claimants',
  'task:change_requester': 'Change the requester',
  'message:create': 'Post comments',
  'message:update': 'Edit comments',
  'message:retire': 'Retire comments',
  'message:revive': 'Revive comments',
  'attachment:create': 'Upload files',
  'attachment:retire': 'Retire files',
  'attachment:revive': 'Revive files',
  'user:update': 'Edit people',
  'user:retire': 'Retire people',
  'user:revive': 'Revive people',
  'user:deactivate': 'Deactivate people',
  'user:reactivate': 'Reactivate people',
  'user:grant_role': 'Give roles',
  'user:revoke_role': 'Take roles away',
  'session:revoke': 'Sign people out',
  'invite:create': 'Send invitations',
  'invite:retire': 'Withdraw invitations',
  'grant:create': 'Add permissions',
  'grant:update': 'Change permissions',
  'grant:retire': 'Remove permissions',
  'grant:revive': 'Restore permissions',
  'role:create': 'Create roles',
  'role:update': 'Edit roles',
  'role:retire': 'Retire roles',
  'role:revive': 'Revive roles',
  'division:create': 'Create divisions',
  'division:update': 'Edit divisions',
  'division:retire': 'Retire divisions',
  'division:revive': 'Revive divisions',
  'team:create': 'Create teams',
  'team:update': 'Edit teams',
  'team:retire': 'Retire teams',
  'team:revive': 'Revive teams',
  'config:update': 'Change settings',
  'integration:create': 'Connect integrations',
  'integration:update': 'Edit integrations',
  'integration:retire': 'Retire integrations',
  'integration:revive': 'Revive integrations',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Resource groups, in display order, keyed by the action's `resource:` prefix. */
export const ACTION_GROUPS: { name: string; prefixes: string[] }[] = [
  { name: 'Tasks', prefixes: ['task'] },
  { name: 'Messages and attachments', prefixes: ['message', 'attachment'] },
  { name: 'People', prefixes: ['user', 'session', 'invite'] },
  { name: 'Divisions and teams', prefixes: ['division', 'team'] },
  { name: 'Governance', prefixes: ['grant', 'role'] },
  { name: 'Settings and integrations', prefixes: ['config', 'integration'] },
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

/** Short names for `own`, by the owner relation it checks. */
const OWN_LABELS: Record<string, string> = {
  requester: 'Own requests',
  claimant: 'Own claims',
  sender: 'Own comments',
  uploader: 'Own uploads',
  claim_eligibility: 'When eligible',
};

const SCOPE_LABELS: Record<ScopeKind, string> = {
  global: 'Everywhere',
  own_division: 'Own division',
  own_team: 'Own team',
  specific_division: 'Specific division',
  specific_team: 'Specific team',
  role: 'One role',
  own: 'Own',
  assigned: 'Where assigned',
};

export function scopeLabel(scope: ScopeKind, info: ActionInfo): string {
  if (scope === 'global' && info.scopes.length === 1) return 'Granted';
  if (scope === 'own') return OWN_LABELS[info.own ?? ''] ?? 'Own';
  return SCOPE_LABELS[scope];
}

/** What the action's resource is called in a sentence ("tasks", "comments"…). */
const RESOURCE_NOUNS: Record<string, string> = {
  Task: 'tasks',
  Message: 'comments',
  Attachment: 'files',
  Division: 'divisions',
  User: 'people',
};

/**
 * The tooltip for a scope: one or two sentences on exactly what the grant lets the
 * person do. `target` names the picked division, team or role when there is one.
 */
export function scopeHint(scope: ScopeKind, info: ActionInfo, target?: string): string {
  const noun = RESOURCE_NOUNS[info.resourceType] ?? 'things';
  switch (scope) {
    case 'global':
      return info.scopes.length === 1
        ? 'Anyone with this role can do this. It applies to the whole organization.'
        : `Any ${noun} in the organization, whatever their division or team.`;
    case 'own_division':
      return info.resourceType === 'Division'
        ? 'Only divisions the person belongs to.'
        : `Only ${noun} in a division the person belongs to. Belonging to a division means holding its division role.`;
    case 'own_team':
      return `Only ${noun} in a team the person belongs to. Belonging to a team means holding its team role.`;
    case 'specific_division':
      return `Only ${noun} in ${target ?? 'the division you pick'}, whether or not the person belongs to it.`;
    case 'specific_team':
      return `Only ${noun} in ${target ?? 'the team you pick'}, whether or not the person belongs to it.`;
    case 'role':
      return `Only when the role being given or taken away is ${target ?? 'the role you pick'}.`;
    case 'own':
      return OWN_HINTS[info.own ?? ''] ?? `Only ${noun} the person owns.`;
    case 'assigned':
      return `Only ${noun} in the divisions and teams where the person holds this role. A division covers its teams.`;
  }
}

const OWN_HINTS: Record<string, string> = {
  requester: 'Only tasks the person requested.',
  claimant: 'Only tasks the person has claimed.',
  sender: 'Only comments the person wrote.',
  uploader: 'Only files the person uploaded.',
  claim_eligibility:
    'Any task the person is eligible for. A division or team that restricts claims only lets its own members claim.',
};

/** Scopes that need a second picker (division, team or role). */
export function isTargeted(scope: ScopeKind): boolean {
  return scope === 'specific_division' || scope === 'specific_team' || scope === 'role';
}
