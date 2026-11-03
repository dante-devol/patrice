import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';

export type UnitKind = 'division' | 'team';

export interface MemberView {
  userId: string;
  source: 'patrice' | 'integration';
  createdAt: Date;
}

/**
 * Who belongs to a division or team. Membership carries no authority by itself: it
 * feeds the `own_division` / `own_team` scopes and claim restrictions, which Cedar
 * reads from the principal on every request, so changes apply immediately.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  private unitWhere(kind: UnitKind, unitId: string) {
    return kind === 'division' ? { divisionId: unitId } : { teamId: unitId };
  }

  private async assertUnit(kind: UnitKind, unitId: string, forAdding: boolean): Promise<void> {
    const unit =
      kind === 'division'
        ? await this.prisma.division.findUnique({ where: { id: unitId }, select: { lifecycleState: true } })
        : await this.prisma.team.findUnique({ where: { id: unitId }, select: { lifecycleState: true } });
    if (!unit) {
      throw kind === 'division'
        ? new NotFoundError('DIVISION_NOT_FOUND', 'Division not found')
        : new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    }
    // Retired units accept no new members.
    if (forAdding && unit.lifecycleState === LifecycleState.retired) {
      throw kind === 'division'
        ? new ConflictError('DIVISION_RETIRED', 'Division is retired')
        : new ConflictError('TEAM_RETIRED', 'Team is retired');
    }
  }

  async list(kind: UnitKind, unitId: string): Promise<MemberView[]> {
    await this.assertUnit(kind, unitId, false);
    const rows = await this.prisma.membership.findMany({
      where: this.unitWhere(kind, unitId),
      orderBy: { createdAt: 'asc' },
      select: { userId: true, source: true, createdAt: true },
    });
    return rows;
  }

  /** Add a member. Idempotent. */
  async add(kind: UnitKind, unitId: string, userId: string, actorUserId: string): Promise<MemberView[]> {
    await this.assertUnit(kind, unitId, true);
    const user = await this.prisma.appUser.findUnique({ where: { id: userId }, select: { lifecycleState: true } });
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    if (user.lifecycleState === LifecycleState.retired) throw new ConflictError('USER_RETIRED', 'User is retired');
    const existing = await this.prisma.membership.findFirst({ where: { userId, ...this.unitWhere(kind, unitId) } });
    if (!existing) {
      await this.prisma.$transaction(async (tx) => {
        await tx.membership.create({ data: { userId, ...this.unitWhere(kind, unitId), grantedBy: actorUserId } });
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: kind,
          subjectId: unitId,
          verb: 'membership.added',
          payload: { userId, unitType: kind, unitId },
        });
      });
    }
    return this.list(kind, unitId);
  }

  /** Remove a member. Idempotent. */
  async remove(kind: UnitKind, unitId: string, userId: string, actorUserId: string): Promise<void> {
    await this.assertUnit(kind, unitId, false);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.membership.deleteMany({ where: { userId, ...this.unitWhere(kind, unitId) } });
      if (count > 0) {
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: kind,
          subjectId: unitId,
          verb: 'membership.removed',
          payload: { userId, unitType: kind, unitId },
        });
      }
    });
  }
}
