import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Turns a user's grants for a task-read action into a database predicate, so a task
 * list fetches (roughly) only rows the user may see. It is a pre-filter, not the
 * decision: callers still ask Cedar about every returned row, which is what makes
 * forbids and the Discord gate apply. The predicate must therefore never exclude a
 * task Cedar would allow; it may include extras.
 */
@Injectable()
export class VisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** `null` when the user may see everything (a global permit), else a where clause. */
  async taskWhere(userId: string, action: string): Promise<Prisma.TaskWhereInput | null> {
    const [grants, memberships] = await Promise.all([
      this.prisma.grant.findMany({
        where: {
          action,
          effect: 'permit',
          // Org roles the user holds, and Everyone, which every user holds (ADR 0022).
          role: { lifecycleState: 'active', OR: [{ userRoles: { some: { userId } } }, { kind: 'baseline' }] },
        },
        select: { scopeKind: true, scopeDivisionId: true, scopeTeamId: true },
      }),
      this.prisma.membership.findMany({ where: { userId }, select: { divisionId: true, teamId: true } }),
    ]);
    if (grants.some((g) => g.scopeKind === 'global')) return null;

    const myDivisions = memberships.flatMap((m) => (m.divisionId ? [m.divisionId] : []));
    const myTeams = memberships.flatMap((m) => (m.teamId ? [m.teamId] : []));
    const or: Prisma.TaskWhereInput[] = [];
    for (const g of grants) {
      switch (g.scopeKind) {
        case 'specific_division':
          if (g.scopeDivisionId) or.push({ divisionId: g.scopeDivisionId });
          break;
        case 'specific_team':
          if (g.scopeTeamId) or.push({ teamId: g.scopeTeamId });
          break;
        case 'own_division':
          or.push({ divisionId: { in: myDivisions } });
          break;
        case 'own_team':
          or.push({ teamId: { in: myTeams } });
          break;
        case 'own':
          // Involved in it: requested it, or holds a seat.
          or.push({ requesterUserId: userId }, { claimants: { some: { userId, leftAt: null } } });
          break;
        default:
          break;
      }
    }
    // Unit roles: where the user holds a unit role with an `assigned` grant for the
    // action, its unit's tasks (a division assignment covers every task in the division, whatever its team).
    const assigned = await this.prisma.unitRoleAssignment.findMany({
      where: {
        userId,
        role: { lifecycleState: 'active', grants: { some: { action, effect: 'permit', scopeKind: 'assigned' } } },
      },
      select: { divisionId: true, teamId: true },
    });
    // A unit role's `own` grant is "involved, in that unit": requested or seated is a superset.
    const ownViaUnit = await this.prisma.unitRoleAssignment.count({
      where: {
        userId,
        role: { lifecycleState: 'active', grants: { some: { action, effect: 'permit', scopeKind: 'own' } } },
      },
    });
    if (ownViaUnit > 0) or.push({ requesterUserId: userId }, { claimants: { some: { userId, leftAt: null } } });
    const ledDivisions = assigned.flatMap((a) => (a.divisionId ? [a.divisionId] : []));
    const ledTeams = assigned.flatMap((a) => (a.teamId ? [a.teamId] : []));
    if (ledDivisions.length > 0) or.push({ divisionId: { in: ledDivisions } });
    if (ledTeams.length > 0) or.push({ teamId: { in: ledTeams } });

    // No grant at all: nothing is visible.
    return or.length > 0 ? { OR: or } : { id: { in: [] } };
  }
}
