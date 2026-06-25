import type { ExternalGroupMapping, UserRole, Role } from '@prisma/client';
import type { ExternalUserId, ExternalGroupId, ExternalRoleOp } from './integration-sync.port';

export interface LinkedUser {
  userId: string;
  externalUserId: ExternalUserId;
}

/** Ops the reconciler wants applied on the Patrice side (grant/revoke user_role). */
export interface PaRoleOp {
  kind: 'grant' | 'revoke';
  userId: string;
  roleId: string;
  /** Source of truth that drove the op (for activity logging). */
  externalGroupId: ExternalGroupId;
}

export interface ReconcileInput {
  /** Active, non-broken mappings for the connection. */
  mappings: ExternalGroupMapping[];
  /** All linked users for the connection. */
  linkedUsers: LinkedUser[];
  /** All external-group → [member external user IDs] from the provider. */
  externalMembership: Map<ExternalUserId, ExternalGroupId[]>;
  /** All known external group IDs (from fetchGroups). Used for broken detection. */
  knownGroupIds: Set<ExternalGroupId>;
  /** All existing user_role rows for the linked users, keyed userId+roleId. */
  existingRoles: Map<string, UserRole>;
  /** All role rows for mapped role IDs. */
  roleRows: Map<string, Role>;
}

export interface ReconcileOutput {
  /** Ops to apply on Patrice (inbound + bidirectional). */
  paOps: PaRoleOp[];
  /** Ops to apply on the external provider (outbound + bidirectional). */
  externalOps: ExternalRoleOp[];
  /** Mapping IDs that should be marked broken (external group no longer exists). */
  brokenMappingIds: string[];
}

const userRoleKey = (userId: string, roleId: string) => `${userId}:${roleId}`;

/**
 * Pure desired-state reconciler.
 *
 * Given Patrice state + external state + mappings, returns the minimal ops to
 * converge both sides. Re-running a converged state produces zero ops.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const paOps: PaRoleOp[] = [];
  const externalOps: ExternalRoleOp[] = [];
  const brokenMappingIds: string[] = [];

  // Build reverse index: externalGroupId → Set<ExternalUserId>
  const membersOf = new Map<ExternalGroupId, Set<ExternalUserId>>();
  for (const [extUserId, groups] of input.externalMembership) {
    for (const gid of groups) {
      let s = membersOf.get(gid);
      if (!s) { s = new Set(); membersOf.set(gid, s); }
      s.add(extUserId);
    }
  }

  for (const mapping of input.mappings) {
    if (mapping.isBroken) continue;

    // Broken-group detection: if the external group doesn't exist in the provider
    // and we have at least one member (so the fetch wasn't empty), flag broken.
    const hasMemberData = input.externalMembership.size > 0;
    if (hasMemberData && !input.knownGroupIds.has(mapping.externalGroupId)) {
      brokenMappingIds.push(mapping.id);
      continue;
    }

    const role = input.roleRows.get(mapping.roleId);
    if (!role || role.lifecycleState === 'retired') continue;

    const externalMembers = membersOf.get(mapping.externalGroupId) ?? new Set<ExternalUserId>();

    for (const link of input.linkedUsers) {
      const hasExternalRole = externalMembers.has(link.externalUserId);
      const existingUR = input.existingRoles.get(userRoleKey(link.userId, mapping.roleId));
      const hasPatriceRole = !!existingUR;

      const dir = mapping.syncDirection;

      // --- Inbound (Discord → Patrice) ---
      if (dir === 'inbound' || dir === 'bidirectional') {
        if (hasExternalRole && !hasPatriceRole) {
          paOps.push({ kind: 'grant', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
        } else if (!hasExternalRole && existingUR?.source === 'integration') {
          paOps.push({ kind: 'revoke', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
        }
      }

      // --- Outbound (Patrice → Discord) ---
      if (dir === 'outbound' || dir === 'bidirectional') {
        if (hasPatriceRole && !hasExternalRole) {
          externalOps.push({ externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, action: 'add' });
        } else if (!hasPatriceRole && hasExternalRole) {
          externalOps.push({ externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, action: 'remove' });
        }
      }
    }
  }

  return { paOps, externalOps, brokenMappingIds };
}
