import { Grant, GrantChange, ScopeKind } from '../../core/api.types';
import { isTargeted } from './permission-labels';

/**
 * The permission editor's working copy. Edits change drafts only; `diffDrafts` turns
 * the difference from the saved grants into the `POST /grants/batch` changes, so
 * nothing reaches the API until the admin saves.
 */
export interface DraftGrant {
  /** Stable row key: the grant id, or `new:N` for a grant that isn't saved yet. */
  key: string;
  /** The saved grant this draft edits, or null for a new one. */
  id: string | null;
  version: number | null;
  roleId: string;
  action: string;
  effect: 'permit' | 'forbid';
  scopeKind: ScopeKind;
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
}

export function draftsFrom(grants: Grant[]): DraftGrant[] {
  return grants.map((g) => ({
    key: g.id,
    id: g.id,
    version: g.version,
    roleId: g.roleId,
    action: g.action,
    effect: g.effect,
    scopeKind: g.scopeKind,
    scopeDivisionId: g.scopeDivisionId,
    scopeTeamId: g.scopeTeamId,
    scopeRoleId: g.scopeRoleId,
  }));
}

/** A draft with a scope kind and the target id (only) that kind needs. */
export function withScope(d: DraftGrant, scopeKind: ScopeKind): DraftGrant {
  return {
    ...d,
    scopeKind,
    scopeDivisionId: scopeKind === 'specific_division' ? d.scopeDivisionId : null,
    scopeTeamId: scopeKind === 'specific_team' ? d.scopeTeamId : null,
    scopeRoleId: scopeKind === 'role' ? d.scopeRoleId : null,
  };
}

export function sameScope(
  a: Pick<DraftGrant, 'scopeKind' | 'scopeDivisionId' | 'scopeTeamId' | 'scopeRoleId' | 'effect'>,
  b: Pick<DraftGrant, 'scopeKind' | 'scopeDivisionId' | 'scopeTeamId' | 'scopeRoleId' | 'effect'>,
): boolean {
  return (
    a.scopeKind === b.scopeKind &&
    a.scopeDivisionId === b.scopeDivisionId &&
    a.scopeTeamId === b.scopeTeamId &&
    a.scopeRoleId === b.scopeRoleId &&
    a.effect === b.effect
  );
}

/** A targeted scope still waiting for its division, team or role. */
export function isIncomplete(d: DraftGrant): boolean {
  if (!isTargeted(d.scopeKind)) return false;
  return !(d.scopeDivisionId ?? d.scopeTeamId ?? d.scopeRoleId);
}

const scopeFields = (d: DraftGrant) => ({
  scopeKind: d.scopeKind,
  scopeDivisionId: d.scopeDivisionId,
  scopeTeamId: d.scopeTeamId,
  scopeRoleId: d.scopeRoleId,
});

/** The batch that turns `saved` into `drafts`: retires first, then updates, then creates. */
export function diffDrafts(saved: Grant[], drafts: DraftGrant[]): GrantChange[] {
  const draftById = new Map(drafts.filter((d) => d.id).map((d) => [d.id as string, d]));
  const changes: GrantChange[] = [];
  for (const g of saved) {
    if (!draftById.has(g.id)) changes.push({ op: 'retire', id: g.id, version: g.version });
  }
  for (const g of saved) {
    const d = draftById.get(g.id);
    if (d && !sameScope(d, g)) {
      changes.push({ op: 'update', id: g.id, version: g.version, ...scopeFields(d) });
    }
  }
  for (const d of drafts) {
    if (!d.id) {
      changes.push({ op: 'create', roleId: d.roleId, action: d.action, effect: d.effect, ...scopeFields(d) });
    }
  }
  return changes;
}

/** `roleId|action` for every role/action pair whose grants differ from what's saved. */
export function changedCells(saved: Grant[], drafts: DraftGrant[]): Set<string> {
  const cell = (x: { roleId: string; action: string }) => `${x.roleId}|${x.action}`;
  const savedById = new Map(saved.map((g) => [g.id, g]));
  const out = new Set<string>();
  const kept = new Set<string>();
  for (const d of drafts) {
    const g = d.id ? savedById.get(d.id) : undefined;
    if (g) kept.add(g.id);
    if (!g || !sameScope(d, g)) out.add(cell(d));
  }
  for (const g of saved) if (!kept.has(g.id)) out.add(cell(g));
  return out;
}
