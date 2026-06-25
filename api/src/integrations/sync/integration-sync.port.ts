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
  /** Permanent failures that should mark the mapping broken. */
  brokenGroupIds: ExternalGroupId[];
}

/**
 * Provider-agnostic seam for integration sync I/O.
 * Reconciliation logic lives in Reconciler; adapters do network I/O only.
 */
export interface IntegrationSyncPort {
  readonly provider: string;

  /** Returns a map from external user ID → list of external group IDs they hold. */
  fetchMembership(conn: IntegrationConnection): Promise<Map<ExternalUserId, ExternalGroupId[]>>;

  /** Returns all groups visible to the bot in the workspace. Used for broken-check. */
  fetchGroups(conn: IntegrationConnection): Promise<ExternalGroup[]>;

  /** Push a batch of role adds/removes to the external provider. Idempotent. */
  applyOutbound(conn: IntegrationConnection, ops: ExternalRoleOp[]): Promise<ApplyResult>;
}
