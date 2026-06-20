/**
 * The closed Action vocabulary (`resource:verb`) — code-defined, admins cannot
 * invent new ones (docs/ARCHITECTURE.md §2.3). Slice 1 only *uses* a handful of
 * these via endpoints, but the governance actions (`grant:*`, `role:*`) are also
 * registered so the seeded Admin can hold them — that is what makes the Admin an
 * **effective admin** and lets bootstrap mode close (see EFFECTIVE_ADMIN_ACTIONS).
 *
 * Each action declares the Cedar **resource entity type** it applies to, which the
 * authorize guard uses to shape the request and the projector uses for schema text.
 */
export type CedarEntityType =
  | 'Organization'
  | 'Invitation'
  | 'User';

export interface ActionDef {
  /** `resource:verb` string — the Cedar action id and the grant.action value. */
  readonly action: string;
  /** Cedar entity type of the resource this action applies to. */
  readonly resourceType: CedarEntityType;
}

export const ACTIONS = {
  inviteCreate: { action: 'invite:create', resourceType: 'Organization' },
  inviteRetire: { action: 'invite:retire', resourceType: 'Invitation' },
  userUpdate: { action: 'user:update', resourceType: 'User' },
  // Governance actions — registered (no endpoints yet) so Admin holds them and the
  // effective-admin predicate is satisfiable. Resource is the singleton org.
  grantCreate: { action: 'grant:create', resourceType: 'Organization' },
  grantUpdate: { action: 'grant:update', resourceType: 'Organization' },
  grantRetire: { action: 'grant:retire', resourceType: 'Organization' },
  roleCreate: { action: 'role:create', resourceType: 'Organization' },
  roleUpdate: { action: 'role:update', resourceType: 'Organization' },
  roleRetire: { action: 'role:retire', resourceType: 'Organization' },
  roleRevive: { action: 'role:revive', resourceType: 'Organization' },
} as const satisfies Record<string, ActionDef>;

export type ActionKey = keyof typeof ACTIONS;

/** All registered action strings (for schema generation + Admin seeding). */
export const ALL_ACTION_STRINGS: readonly string[] = Object.values(ACTIONS).map(
  (a) => a.action,
);

/** Map action string → resource entity type. */
export const RESOURCE_TYPE_BY_ACTION: Readonly<Record<string, CedarEntityType>> =
  Object.fromEntries(Object.values(ACTIONS).map((a) => [a.action, a.resourceType]));

/**
 * Effective-admin governance actions — a `permit` grant on any of these at
 * `scope_kind='global'` (by an active user) makes that user an effective admin.
 * Single source of truth, read by bootstrap (Slice 1) and the administrability
 * invariant (Slice 2/7). Mirrors docs/slices/00-overview.md.
 */
export const EFFECTIVE_ADMIN_ACTIONS: readonly string[] = [
  'grant:create',
  'grant:update',
  'grant:retire',
  'role:create',
  'role:update',
  'role:retire',
];

/**
 * Actions the seeded Admin role receives at `scope_kind='global'` in Slice 1:
 * the invite endpoints it actually uses, plus the governance actions that make it
 * an effective admin. Later slices add more grants via the matrix UI.
 */
export const ADMIN_SEED_ACTIONS: readonly string[] = [
  'invite:create',
  'invite:retire',
  // `*:revive` actions are seeded with global-scoped Admin grants by default
  // (docs/slices/02 action vocabulary); narrower revive authority is delegated
  // via the matrix. Slice 2 seeds role/division/team revive.
  'role:revive',
  ...EFFECTIVE_ADMIN_ACTIONS,
];
