import type { ExternalUserId, ExternalGroupId, ExternalRoleOp } from './integration-sync.port';

/** What a mapping grants in Patrice: a role, or membership of a division or team. */
export type SyncTarget = { kind: 'role' | 'division' | 'team'; id: string };

export const targetKey = (t: SyncTarget): string => `${t.kind}:${t.id}`;

export interface SyncMapping {
  id: string;
  target: SyncTarget;
  externalGroupId: ExternalGroupId;
  syncDirection: 'inbound' | 'outbound' | 'bidirectional';
  conflictWinner: 'patrice' | 'external';
  isBroken: boolean;
}

export interface LinkedUser {
  userId: string;
  externalUserId: ExternalUserId;
}

/** A user's role or membership as Patrice holds it. */
export interface Holding {
  /** `integration` holdings may be revoked by sync; native ones never are. */
  source: 'patrice' | 'integration';
  /** When it was granted (a tie-breaker for cold conflicts). */
  since: Date;
}

/** Patrice-side change: grant or revoke a target for a user. */
export interface PatriceOp {
  kind: 'grant' | 'revoke';
  userId: string;
  target: SyncTarget;
  mappingId: string;
  externalGroupId: ExternalGroupId;
}

/**
 * The value a bidirectional edge converges to. It's written to the baseline only once
 * the change it depends on has happened: an outbound push must succeed first, which
 * is what keeps a pushed grant from being recorded as absent (problems D9).
 */
export interface BaselineEdge {
  mappingId: string;
  userId: string;
  externalUserId: ExternalUserId;
  externalGroupId: ExternalGroupId;
  present: boolean;
  /** The outbound op that must succeed before this edge is recorded. */
  dependsOn?: ExternalRoleOp;
}

/** Edges present at the last convergence; key `${externalUserId}:${externalGroupId}`. */
export type SyncBaseline = Set<string>;

export interface ReconcileInput {
  mappings: SyncMapping[];
  linkedUsers: LinkedUser[];
  /** External user → the external groups they hold. */
  externalMembership: Map<ExternalUserId, ExternalGroupId[]>;
  /** Every group the provider reports (a mapped group missing from it is broken). */
  knownGroupIds: Set<ExternalGroupId>;
  /** Patrice holdings of mapped targets, keyed `${userId}|${targetKey}`. */
  holdings: Map<string, Holding>;
  /** Targets sync must leave alone (a retired role, unit or team). */
  inactiveTargets: Set<string>;
  /** Undefined: no baseline yet (cold). */
  baseline?: SyncBaseline;
  /** When the provider last changed an edge, where known (keyed like the baseline). */
  externalChangedAt?: Map<string, Date>;
}

export interface ReconcileOutput {
  patriceOps: PatriceOp[];
  externalOps: ExternalRoleOp[];
  brokenMappingIds: string[];
  /** Bidirectional edges to record once their changes have happened. */
  baselineEdges: BaselineEdge[];
}

export const holdingKey = (userId: string, target: SyncTarget): string => `${userId}|${targetKey(target)}`;
const edgeKey = (extUserId: string, extGroupId: string) => `${extUserId}:${extGroupId}`;

/**
 * Pure desired-state reconciler. Given both sides, the mappings and (for
 * bidirectional mappings) the baseline, it returns the smallest set of changes that
 * converges them; a converged state yields none.
 *
 * - Inbound: the provider is the source of truth. Sync grants, and revokes only what
 *   it granted itself; a native grant is never revoked.
 * - Outbound: Patrice is the source of truth.
 * - Bidirectional: with a baseline, the side that moved since the last convergence
 *   wins. Without one (or when both moved), the later change wins when both times are
 *   known, else the mapping's `conflict_winner`.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const out: ReconcileOutput = { patriceOps: [], externalOps: [], brokenMappingIds: [], baselineEdges: [] };

  const membersOf = new Map<ExternalGroupId, Set<ExternalUserId>>();
  for (const [extUserId, groups] of input.externalMembership) {
    for (const gid of groups) {
      let set = membersOf.get(gid);
      if (!set) membersOf.set(gid, (set = new Set()));
      set.add(extUserId);
    }
  }

  for (const mapping of input.mappings) {
    if (mapping.isBroken) continue;
    // A group the provider no longer reports (and the fetch wasn't empty) is broken.
    if (input.externalMembership.size > 0 && !input.knownGroupIds.has(mapping.externalGroupId)) {
      out.brokenMappingIds.push(mapping.id);
      continue;
    }
    if (input.inactiveTargets.has(targetKey(mapping.target))) continue;
    const members = membersOf.get(mapping.externalGroupId) ?? new Set<ExternalUserId>();

    for (const link of input.linkedUsers) {
      const edge = {
        hasExternal: members.has(link.externalUserId),
        holding: input.holdings.get(holdingKey(link.userId, mapping.target)),
      };
      const decision = decide(mapping, link, edge, input);
      if (decision.patrice) {
        out.patriceOps.push({
          kind: decision.patrice,
          userId: link.userId,
          target: mapping.target,
          mappingId: mapping.id,
          externalGroupId: mapping.externalGroupId,
        });
      }
      const extOp: ExternalRoleOp | undefined = decision.external
        ? { externalUserId: link.externalUserId, externalGroupId: mapping.externalGroupId, action: decision.external }
        : undefined;
      if (extOp) out.externalOps.push(extOp);

      if (mapping.syncDirection === 'bidirectional' && decision.converged !== undefined) {
        out.baselineEdges.push({
          mappingId: mapping.id,
          userId: link.userId,
          externalUserId: link.externalUserId,
          externalGroupId: mapping.externalGroupId,
          present: decision.converged,
          ...(extOp ? { dependsOn: extOp } : {}),
        });
      }
    }
  }
  return out;
}

interface Decision {
  patrice?: 'grant' | 'revoke';
  external?: 'add' | 'remove';
  /** The edge's value once the changes apply; undefined when it stays diverged. */
  converged?: boolean;
}

function decide(
  mapping: SyncMapping,
  link: LinkedUser,
  edge: { hasExternal: boolean; holding: Holding | undefined },
  input: ReconcileInput,
): Decision {
  const hasPatrice = edge.holding !== undefined;
  const revocable = edge.holding?.source === 'integration';

  /** Patrice follows the provider (a native holding is never revoked). */
  const followExternal = (): Decision => {
    if (edge.hasExternal && !hasPatrice) return { patrice: 'grant', converged: true };
    if (!edge.hasExternal && hasPatrice) {
      return revocable ? { patrice: 'revoke', converged: false } : { external: 'add', converged: true };
    }
    return { converged: edge.hasExternal };
  };
  /** The provider follows Patrice. */
  const followPatrice = (): Decision =>
    hasPatrice === edge.hasExternal
      ? { converged: hasPatrice }
      : { external: hasPatrice ? 'add' : 'remove', converged: hasPatrice };

  switch (mapping.syncDirection) {
    case 'inbound': {
      if (edge.hasExternal && !hasPatrice) return { patrice: 'grant' };
      if (!edge.hasExternal && revocable) return { patrice: 'revoke' };
      return {};
    }
    case 'outbound':
      return followPatrice();
    case 'bidirectional': {
      if (hasPatrice === edge.hasExternal) return { converged: hasPatrice };
      const key = edgeKey(link.externalUserId, mapping.externalGroupId);
      if (input.baseline) {
        const was = input.baseline.has(key);
        const externalMoved = edge.hasExternal !== was;
        const patriceMoved = hasPatrice !== was;
        if (externalMoved && !patriceMoved) return followExternal();
        if (patriceMoved && !externalMoved) return followPatrice();
      }
      // Cold, or both moved: the later change wins when both are known.
      const externalAt = input.externalChangedAt?.get(key);
      const patriceAt = edge.holding?.since;
      if (externalAt && patriceAt) {
        return externalAt > patriceAt ? followExternal() : followPatrice();
      }
      return mapping.conflictWinner === 'external' ? followExternal() : followPatrice();
    }
  }
}
