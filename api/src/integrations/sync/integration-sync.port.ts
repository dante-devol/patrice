import type { IntegrationConnection } from '@prisma/client';

export type ExternalUserId = string;
export type ExternalGroupId = string;

export interface ExternalGroup {
  id: ExternalGroupId;
  name: string;
}

/** One outbound role op the reconciler wants the adapter to apply to the provider. */
export interface ExternalRoleOp {
  externalUserId: ExternalUserId;
  externalGroupId: ExternalGroupId;
  /** add = grant the external role; remove = revoke it */
  action: 'add' | 'remove';
}

export interface ApplyResult {
  applied: number;
  failed: number;
  /** The ops that succeeded — used to log one activity row per (user, role) push. */
  appliedOps: ExternalRoleOp[];
  /** Permanent failures that should mark the mapping broken. */
  brokenGroupIds: ExternalGroupId[];
  /** Human-readable reason for the last outbound failure (surfaced to admins). */
  lastError?: string;
  /** The credentials were rejected: stop, and mark the connection broken. */
  credentialsRejected?: boolean;
  /** Machine reason code for the failure (the UI/activity humanizes it). */
  failReason?: OutboundFailReason;
}

export type OutboundFailReason = 'permission' | 'not_found' | 'other';

/**
 * The provider seam for sync. Adapters do I/O only (members, groups, pushes, and
 * provider specifics such as guild ids and the bot token); what to change is decided
 * by the reconciler and applied by the SyncEngine, which knows no provider.
 */
export interface IntegrationSyncPort {
  readonly provider: string;

  /** Returns a map from external user ID → list of external group IDs they hold. */
  fetchMembership(conn: IntegrationConnection): Promise<Map<ExternalUserId, ExternalGroupId[]>>;

  /** One member's groups; empty when they aren't in the workspace. */
  fetchMember(conn: IntegrationConnection, externalUserId: ExternalUserId): Promise<ExternalGroupId[]>;

  /**
   * When each recent (user, group) edge last changed on the provider, keyed
   * `${externalUserId}:${externalGroupId}`, where the provider can tell. Used to break
   * cold-baseline conflicts; an empty map falls back to the mapping's winner.
   */
  fetchRecentGroupChanges(conn: IntegrationConnection): Promise<Map<string, Date>>;

  /** Returns all groups visible to the bot in the workspace. Used for broken-check. */
  fetchGroups(conn: IntegrationConnection): Promise<ExternalGroup[]>;

  /** Push a batch of role adds/removes to the external provider. Idempotent. */
  applyOutbound(conn: IntegrationConnection, ops: ExternalRoleOp[]): Promise<ApplyResult>;
}

/** The sync port binding (the Discord adapter, today). */
export const INTEGRATION_SYNC_PORT = Symbol('INTEGRATION_SYNC_PORT');
