import { Global, Injectable, Module } from '@nestjs/common';
import { LifecycleState, Prisma, PrismaClient, RoleKind } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { UnprocessableError } from '../common/errors';

export type UnitKind = 'division' | 'team';

export interface UnitRef {
  kind: UnitKind;
  id: string;
}

type Tx = Prisma.TransactionClient;
type Db = Prisma.TransactionClient | PrismaClient;

const unitWhere = (u: UnitRef) => (u.kind === 'division' ? { divisionId: u.id } : { teamId: u.id });

/**
 * A unit's **default role** (ADR 0022): the unit role people get when they join a
 * division or team. Every place that adds or removes a membership calls this, in the
 * same transaction, so joining and leaving always carry the role with them.
 *
 * The role is recorded `via_default`, so leaving removes only what joining gave; roles
 * someone was appointed to stay (ADR 0019). Assignments shape the projected policies,
 * so a change bumps `config_version`.
 */
@Injectable()
export class UnitDefaultsService {
  constructor(private readonly activity: ActivityService) {}

  /** A role that may be a unit's default: an active unit role (422 `NOT_A_DEFAULT_ROLE`). */
  async assertDefaultRole(db: Db, roleId: string | null | undefined): Promise<void> {
    if (!roleId) return;
    const role = await db.role.findUnique({ where: { id: roleId }, select: ROLE });
    if (!role || role.kind !== RoleKind.unit || role.lifecycleState !== LifecycleState.active) {
      throw new UnprocessableError('NOT_A_DEFAULT_ROLE', "A unit's default role must be an active unit role");
    }
  }

  /** The default role a new division or team starts with (the org setting), if still valid. */
  async forNewUnit(db: Db): Promise<string | null> {
    const s = await db.systemSettings.findUnique({
      where: { id: 1 },
      select: { defaultUnitRole: { select: ROLE } },
    });
    const role = s?.defaultUnitRole;
    return role && role.kind === RoleKind.unit && role.lifecycleState === LifecycleState.active ? role.id : null;
  }

  /** The unit's default role, when it has one that can be given (an active unit role). */
  async defaultRoleOf(tx: Tx, unit: UnitRef): Promise<string | null> {
    const row =
      unit.kind === 'division'
        ? await tx.division.findUnique({ where: { id: unit.id }, select: { defaultRole: { select: ROLE } } })
        : await tx.team.findUnique({ where: { id: unit.id }, select: { defaultRole: { select: ROLE } } });
    const role = row?.defaultRole;
    return role && role.kind === RoleKind.unit && role.lifecycleState === LifecycleState.active ? role.id : null;
  }

  /**
   * Someone just joined `unit`: give them its default role there, unless they already
   * hold it. Returns whether an assignment was made.
   */
  async joined(tx: Tx, userId: string, unit: UnitRef, actorUserId: string | null): Promise<boolean> {
    const roleId = await this.defaultRoleOf(tx, unit);
    if (!roleId) return false;
    return (await this.give(tx, [userId], roleId, unit, actorUserId)) > 0;
  }

  /** Someone just left `unit`: remove the roles joining gave them there. */
  async left(tx: Tx, userId: string, unit: UnitRef, actorUserId: string | null): Promise<number> {
    const rows = await tx.unitRoleAssignment.findMany({
      where: { userId, viaDefault: true, ...unitWhere(unit) },
      select: { id: true, roleId: true },
    });
    if (rows.length === 0) return 0;
    await tx.unitRoleAssignment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const r of rows) {
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: unit.kind,
        subjectId: unit.id,
        verb: 'unit_role.unassigned',
        payload: { userId, roleId: r.roleId, unitType: unit.kind, unitId: unit.id, viaDefault: true },
      });
    }
    await bump(tx);
    return rows.length;
  }

  /**
   * Give `roleId` at `unit` to each of `userIds` who doesn't hold it there, recorded
   * `via_default`. Used on joining, and to hand a changed default to current members.
   */
  async give(tx: Tx, userIds: string[], roleId: string, unit: UnitRef, actorUserId: string | null): Promise<number> {
    const holders = new Set(
      (
        await tx.unitRoleAssignment.findMany({
          where: { roleId, userId: { in: userIds }, ...unitWhere(unit) },
          select: { userId: true },
        })
      ).map((a) => a.userId),
    );
    const missing = [...new Set(userIds)].filter((u) => !holders.has(u));
    for (const userId of missing) {
      await tx.unitRoleAssignment.create({
        data: { userId, roleId, ...unitWhere(unit), viaDefault: true, grantedBy: actorUserId },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: unit.kind,
        subjectId: unit.id,
        verb: 'unit_role.assigned',
        payload: { userId, roleId, unitType: unit.kind, unitId: unit.id, viaDefault: true },
      });
    }
    if (missing.length > 0) await bump(tx);
    return missing.length;
  }
}

const ROLE = { id: true, kind: true, lifecycleState: true } as const;

/** Assignments change the projected policy set (ADR 0019). */
async function bump(tx: Tx): Promise<void> {
  await tx.systemSettings.update({ where: { id: 1 }, data: { configVersion: { increment: 1 } } });
}

/** Global, so the membership editor, unit roles and the Discord sync share it. */
@Global()
@Module({ providers: [UnitDefaultsService], exports: [UnitDefaultsService] })
export class UnitDefaultsModule {}
