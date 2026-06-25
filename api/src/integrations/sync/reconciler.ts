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

/**
 * A sparse set of (externalUserId, externalGroupId) edges that were present at
 * last convergence. Absence = was absent at last convergence.
 */
export type SyncBaseline = Set<string>; // key: `${externalUserId}:${externalGroupId}`

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
  /**
   * The sync baseline for bidirectional attribution (#59).
   * Key: `${externalUserId}:${externalGroupId}` — present = was present at last convergence.
   * Undefined = baseline not available (cold-baseline path).
   */
  baseline?: SyncBaseline;
}

export interface ReconcileOutput {
  /** Ops to apply on Patrice (inbound + bidirectional). */
  paOps: PaRoleOp[];
  /** Ops to apply on the external provider (outbound + bidirectional). */
  externalOps: ExternalRoleOp[];
  /** Mapping IDs that should be marked broken (external group no longer exists). */
  brokenMappingIds: string[];
  /** Baseline edges to upsert after a converging run (present after convergence). */
  baselineUpserts: Array<{ externalUserId: string; externalGroupId: string; mappingId: string }>;
  /** Baseline edges to delete (absent after convergence). */
  baselineDeletes: Array<{ externalUserId: string; externalGroupId: string; mappingId: string }>;
}

const userRoleKey = (userId: string, roleId: string) => `${userId}:${roleId}`;
const baselineKey = (extUserId: string, extGroupId: string) => `${extUserId}:${extGroupId}`;

/**
 * Pure desired-state reconciler (#56, extended in #59 for bidirectional attribution).
 *
 * Given Patrice state + external state + mappings (+ optional baseline), returns the
 * minimal ops to converge both sides. Re-running a converged state produces zero ops.
 *
 * Bidirectional resolution (when baseline is available):
 *   - Baseline present, both sides agree → no-op.
 *   - Baseline present, exactly one side diverged → that side propagates.
 *   - Baseline absent (cold) → conflict_winner on the mapping determines authority.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const paOps: PaRoleOp[] = [];
  const externalOps: ExternalRoleOp[] = [];
  const brokenMappingIds: string[] = [];
  const baselineUpserts: ReconcileOutput['baselineUpserts'] = [];
  const baselineDeletes: ReconcileOutput['baselineDeletes'] = [];

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

      if (dir === 'inbound') {
        if (hasExternalRole && !hasPatriceRole) {
          paOps.push({ kind: 'grant', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
        } else if (!hasExternalRole && existingUR?.source === 'integration') {
          paOps.push({ kind: 'revoke', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
        }
      } else if (dir === 'outbound') {
        if (hasPatriceRole && !hasExternalRole) {
          externalOps.push({ externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, action: 'add' });
        } else if (!hasPatriceRole && hasExternalRole) {
          externalOps.push({ externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, action: 'remove' });
        }
      } else {
        // bidirectional — divergence attribution
        reconcileBidirectional({
          link,
          mapping,
          hasExternalRole,
          hasPatriceRole,
          existingUR,
          baseline: input.baseline,
          paOps,
          externalOps,
        });
      }

      // Track baseline state for this edge (for upsert after convergence).
      const bk = { externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, mappingId: mapping.id };
      if (hasExternalRole) {
        baselineUpserts.push(bk);
      } else {
        baselineDeletes.push(bk);
      }
    }
  }

  return { paOps, externalOps, brokenMappingIds, baselineUpserts, baselineDeletes };
}

interface BidirectionalArgs {
  link: LinkedUser;
  mapping: ExternalGroupMapping;
  hasExternalRole: boolean;
  hasPatriceRole: boolean;
  existingUR: UserRole | undefined;
  baseline: SyncBaseline | undefined;
  paOps: PaRoleOp[];
  externalOps: ExternalRoleOp[];
}

function reconcileBidirectional(args: BidirectionalArgs): void {
  const { link, mapping, hasExternalRole, hasPatriceRole, existingUR, baseline, paOps, externalOps } = args;

  if (hasExternalRole === hasPatriceRole) return; // already converged

  const bKey = baselineKey(link.externalUserId, mapping.externalGroupId);
  const wasInBaseline = baseline?.has(bKey); // undefined = cold (baseline unknown)

  if (baseline !== undefined) {
    // Warm baseline: one side diverged from the last-converged state.
    const externalDiverged = hasExternalRole !== (wasInBaseline ?? false);
    const patriceDiverged = hasPatriceRole !== (wasInBaseline ?? false);

    if (externalDiverged && !patriceDiverged) {
      // Discord moved — propagate to Patrice.
      if (hasExternalRole) {
        paOps.push({ kind: 'grant', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
      } else if (existingUR?.source === 'integration') {
        paOps.push({ kind: 'revoke', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
      }
    } else if (patriceDiverged && !externalDiverged) {
      // Patrice moved — propagate to Discord.
      externalOps.push({
        externalUserId: link.externalUserId,
        externalGroupId: mapping.externalGroupId,
        action: hasPatriceRole ? 'add' : 'remove',
      });
    }
    // Both diverged simultaneously: fall through to cold-baseline path below.
    if (!externalDiverged || !patriceDiverged) return;
  }

  // Cold-baseline (first sync, lost state, or simultaneous divergence): use conflict_winner.
  const winner = (mapping as ExternalGroupMapping & { conflictWinner?: string }).conflictWinner ?? 'patrice';
  if (winner === 'external') {
    if (hasExternalRole && !hasPatriceRole) {
      paOps.push({ kind: 'grant', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
    } else if (!hasExternalRole && existingUR?.source === 'integration') {
      paOps.push({ kind: 'revoke', userId: link.userId, roleId: mapping.roleId, externalGroupId: mapping.externalGroupId });
    }
  } else {
    // patrice wins
    externalOps.push({
      externalUserId: link.externalUserId,
      externalGroupId: mapping.externalGroupId,
      action: hasPatriceRole ? 'add' : 'remove',
    });
  }
}
