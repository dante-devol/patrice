import type { ExternalGroupMapping } from '@prisma/client';
import type { SyncTarget } from './reconciler';

/** What a mapping grants: its role, or membership of its division or team. */
export function mappingTarget(m: Pick<ExternalGroupMapping, 'roleId' | 'divisionId' | 'teamId'>): SyncTarget {
  if (m.roleId) return { kind: 'role', id: m.roleId };
  if (m.divisionId) return { kind: 'division', id: m.divisionId };
  return { kind: 'team', id: m.teamId! };
}
