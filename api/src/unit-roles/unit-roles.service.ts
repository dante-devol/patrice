import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, RoleKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { EntityLoader } from '../access/entity-loader';
import { CedarEngine } from '../access/cedar/engine';
import type { ResourceRef } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { EventStore } from '../events/event-store.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';

export type UnitType = 'division' | 'team';

export interface UnitRoleAssignmentView {
  id: string;
  userId: string;
  roleId: string;
  grantedBy: string | null;
  createdAt: Date;
}

/** One division or team the caller belongs to or holds a unit role at. */
export interface MyUnitView {
  unitType: UnitType;
  unitId: string;
  name: string;
  /** For a team: the division it belongs to. */
  divisionId: string | null;
  member: boolean;
  /** The unit roles the caller holds there. */
  roleIds: string[];
}

const VIEW = { id: true, userId: true, roleId: true, grantedBy: true, createdAt: true } as const;

const ASSIGN_ACTION: Record<UnitType, string> = {
  division: ACTIONS.divisionAssignRoles.action,
  team: ACTIONS.teamAssignRoles.action,
};

/**
 * Unit roles held at a division or team (ADR 0019). A unit role's grants (scope
 * `assigned`) apply only where it's assigned; a division assignment also covers its
 * teams. Assigning needs `*:assign_roles` on the unit — and when that comes through a
 * unit role, the target role must be assignable by leads (enforced in Cedar). Assigning
 * also makes the person a member if they weren't; unassigning keeps the membership.
 * Every change bumps `config_version`, because the projected policies name the units
 * where each unit role is assigned.
 */
@Injectable()
export class UnitRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly events: EventStore,
  ) {}

  private unitWhere(unitType: UnitType, unitId: string) {
    return unitType === 'division' ? { divisionId: unitId } : { teamId: unitId };
  }

  private async unitResource(unitType: UnitType, unitId: string): Promise<ResourceRef> {
    const loader = new EntityLoader(this.prisma);
    return unitType === 'division' ? loader.division(unitId) : loader.team(unitId);
  }

  /** The unit, as a Cedar resource that names the role being assigned. */
  private withTarget(base: ResourceRef, role: { id: string; assignableByLeads: boolean }): ResourceRef {
    return {
      ...base,
      attrs: {
        ...base.attrs,
        targetRole: { __entity: { type: CedarEngine.qualify('Role'), id: role.id } },
        targetRoleAssignableByLeads: role.assignableByLeads,
      },
    };
  }

  private async loadUnit(unitType: UnitType, unitId: string) {
    const unit =
      unitType === 'division'
        ? await this.prisma.division.findUnique({ where: { id: unitId }, select: { lifecycleState: true } })
        : await this.prisma.team.findUnique({ where: { id: unitId }, select: { lifecycleState: true } });
    if (!unit) {
      throw unitType === 'division'
        ? new NotFoundError('DIVISION_NOT_FOUND', 'Division not found')
        : new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    }
    return unit;
  }

  /** Who holds which unit role at the unit (the leadership list). */
  async list(unitType: UnitType, unitId: string): Promise<UnitRoleAssignmentView[]> {
    await this.loadUnit(unitType, unitId);
    return this.prisma.unitRoleAssignment.findMany({
      where: this.unitWhere(unitType, unitId),
      orderBy: { createdAt: 'asc' },
      select: VIEW,
    });
  }

  /** The unit roles the caller may assign at the unit (feeds the role picker). */
  async assignableRoles(unitType: UnitType, unitId: string, actorUserId: string) {
    await this.loadUnit(unitType, unitId);
    const roles = await this.prisma.role.findMany({
      where: { kind: RoleKind.unit, lifecycleState: LifecycleState.active },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, assignableByLeads: true },
    });
    const base = await this.unitResource(unitType, unitId);
    const checks = roles.map((r) => ({ action: ASSIGN_ACTION[unitType], resource: this.withTarget(base, r) }));
    const allowed = await this.access.decideMany(actorUserId, checks);
    return roles.filter((_, i) => allowed[i]).map((r) => ({ id: r.id, name: r.name }));
  }

  async assign(
    unitType: UnitType,
    unitId: string,
    actorUserId: string,
    dto: { userId: string; roleId: string },
  ): Promise<UnitRoleAssignmentView> {
    const unit = await this.loadUnit(unitType, unitId);
    if (unit.lifecycleState === LifecycleState.retired) {
      throw unitType === 'division'
        ? new ConflictError('DIVISION_RETIRED', 'Division is retired')
        : new ConflictError('TEAM_RETIRED', 'Team is retired');
    }
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
      select: { id: true, kind: true, lifecycleState: true, assignableByLeads: true },
    });
    if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
    if (role.kind !== RoleKind.unit) throw new UnprocessableError('NOT_A_UNIT_ROLE', 'Only a unit role can be assigned at a division or team');
    if (role.lifecycleState === LifecycleState.retired) throw new UnprocessableError('ROLE_RETIRED', 'Role is retired');
    const user = await this.prisma.appUser.findUnique({ where: { id: dto.userId }, select: { lifecycleState: true } });
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    if (user.lifecycleState === LifecycleState.retired) throw new ConflictError('USER_RETIRED', 'User is retired');
    await this.access.assert(actorUserId, ASSIGN_ACTION[unitType], this.withTarget(await this.unitResource(unitType, unitId), role));

    const where = { userId: dto.userId, roleId: role.id, ...this.unitWhere(unitType, unitId) };
    const existing = await this.prisma.unitRoleAssignment.findFirst({ where, select: VIEW });
    if (existing) return existing; // idempotent

    const created = await this.prisma.$transaction(async (tx) => {
      const a = await tx.unitRoleAssignment.create({ data: { ...where, grantedBy: actorUserId }, select: VIEW });
      await this.ensureMembership(tx, unitType, unitId, dto.userId, actorUserId);
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: unitType,
        subjectId: unitId,
        verb: 'unit_role.assigned',
        payload: { userId: dto.userId, roleId: role.id, unitType, unitId },
      });
      await this.events.record(tx, {
        type: 'unit_role.assigned',
        actorUserId,
        payload: { roleId: role.id, unitType, unitId },
        notify: { type: 'unit_role.assigned', recipients: [dto.userId] },
      });
      await this.access.bumpConfigVersion(tx);
      return a;
    });
    await this.events.deliver();
    return created;
  }

  async unassign(unitType: UnitType, unitId: string, assignmentId: string, actorUserId: string): Promise<void> {
    await this.loadUnit(unitType, unitId);
    const a = await this.prisma.unitRoleAssignment.findUnique({
      where: { id: assignmentId },
      include: { role: { select: { id: true, assignableByLeads: true } } },
    });
    const here = unitType === 'division' ? a?.divisionId === unitId : a?.teamId === unitId;
    if (!a || !here) throw new NotFoundError('ASSIGNMENT_NOT_FOUND', 'Role assignment not found');
    await this.access.assert(actorUserId, ASSIGN_ACTION[unitType], this.withTarget(await this.unitResource(unitType, unitId), a.role));
    await this.prisma.$transaction(async (tx) => {
      await tx.unitRoleAssignment.delete({ where: { id: a.id } });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: unitType,
        subjectId: unitId,
        verb: 'unit_role.unassigned',
        payload: { userId: a.userId, roleId: a.roleId, unitType, unitId },
      });
      await this.access.bumpConfigVersion(tx);
    });
  }

  /** The divisions and teams the user belongs to or holds unit roles at, by name. */
  async mine(userId: string): Promise<MyUnitView[]> {
    const [memberships, assignments] = await Promise.all([
      this.prisma.membership.findMany({
        where: { userId },
        select: {
          division: { select: { id: true, name: true, lifecycleState: true } },
          team: { select: { id: true, name: true, divisionId: true, lifecycleState: true } },
        },
      }),
      this.prisma.unitRoleAssignment.findMany({
        where: { userId, role: { lifecycleState: LifecycleState.active } },
        select: {
          roleId: true,
          division: { select: { id: true, name: true, lifecycleState: true } },
          team: { select: { id: true, name: true, divisionId: true, lifecycleState: true } },
        },
      }),
    ]);
    const units = new Map<string, MyUnitView>();
    const upsert = (
      u: { id: string; name: string; lifecycleState: LifecycleState; divisionId?: string },
      unitType: UnitType,
    ): MyUnitView | null => {
      if (u.lifecycleState === LifecycleState.retired) return null;
      const key = `${unitType}:${u.id}`;
      let v = units.get(key);
      if (!v) {
        v = { unitType, unitId: u.id, name: u.name, divisionId: u.divisionId ?? null, member: false, roleIds: [] };
        units.set(key, v);
      }
      return v;
    };
    for (const m of memberships) {
      const v = m.division ? upsert(m.division, 'division') : m.team ? upsert(m.team, 'team') : null;
      if (v) v.member = true;
    }
    for (const a of assignments) {
      const v = a.division ? upsert(a.division, 'division') : a.team ? upsert(a.team, 'team') : null;
      if (v && !v.roleIds.includes(a.roleId)) v.roleIds.push(a.roleId);
    }
    return [...units.values()].sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Make the person a member of the unit if they aren't (leading implies belonging). */
  private async ensureMembership(
    tx: Prisma.TransactionClient,
    unitType: UnitType,
    unitId: string,
    userId: string,
    actorUserId: string,
  ): Promise<void> {
    const where = { userId, ...this.unitWhere(unitType, unitId) };
    if (await tx.membership.findFirst({ where, select: { id: true } })) return;
    await tx.membership.create({ data: { ...where, grantedBy: actorUserId } });
    await this.activity.logActivity({
      tx,
      actorUserId,
      subjectType: unitType,
      subjectId: unitId,
      verb: 'membership.added',
      payload: { userId, unitType, unitId },
    });
  }
}
