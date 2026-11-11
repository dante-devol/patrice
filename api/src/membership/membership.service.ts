import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, DeniedError, NotFoundError, ValidationError } from '../common/errors';
import { AccessService, ResourceRef } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { divisionRef, TEAM_REF_SELECT, teamRefOf } from '../access/entity-loader';
import { BatchMembershipsDto } from './membership.dto';

export type UnitKind = 'division' | 'team';

/** One membership row across every unit, for the membership editor. */
export interface MembershipView {
  userId: string;
  unitType: UnitKind;
  unitId: string;
  source: 'patrice' | 'integration';
  createdAt: Date;
}

/** A unit the caller may read, and what they may do with its members. */
export interface MembershipUnitView {
  unitType: UnitKind;
  unitId: string;
  /** `division:manage_members` / `team:manage_members` when the caller holds it. */
  allowedActions: string[];
}

export interface MembershipsView {
  items: MembershipView[];
  units: MembershipUnitView[];
}

interface UnitRow {
  kind: UnitKind;
  id: string;
  lifecycleState: LifecycleState;
  ref: ResourceRef;
}

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
    private readonly access: AccessService,
  ) {}

  private unitKey(kind: UnitKind, id: string): string {
    return `${kind}:${id}`;
  }

  /** Every division and team, keyed `kind:id`, with the Cedar resource for each. */
  private async loadUnits(): Promise<Map<string, UnitRow>> {
    const [divisions, teams] = await Promise.all([
      this.prisma.division.findMany({
        select: { id: true, restrictClaims: true, allowCustomTemplates: true, lifecycleState: true },
      }),
      this.prisma.team.findMany({
        select: { ...TEAM_REF_SELECT, lifecycleState: true },
      }),
    ]);
    const units = new Map<string, UnitRow>();
    for (const d of divisions) {
      units.set(this.unitKey('division', d.id), {
        kind: 'division',
        id: d.id,
        lifecycleState: d.lifecycleState,
        ref: divisionRef(d),
      });
    }
    for (const t of teams) {
      units.set(this.unitKey('team', t.id), { kind: 'team', id: t.id, lifecycleState: t.lifecycleState, ref: teamRefOf(t) });
    }
    return units;
  }

  /**
   * Every membership in a unit the caller may read (`division:read` / `team:read`), with
   * each readable unit's `allowedActions` so the editor offers only changes it may save.
   */
  async listAll(userId: string): Promise<MembershipsView> {
    const units = [...(await this.loadUnits()).values()];
    const decisions = await this.access.decideMany(
      userId,
      units.flatMap((u) => [
        { action: u.kind === 'division' ? ACTIONS.divisionRead.action : ACTIONS.teamRead.action, resource: u.ref },
        { action: this.manageAction(u.kind), resource: u.ref },
      ]),
    );
    const readable = units.filter((_, i) => decisions[2 * i]);
    const visible = new Set(readable.map((u) => this.unitKey(u.kind, u.id)));
    const unitViews = units.flatMap((u, i) =>
      decisions[2 * i]
        ? [{ unitType: u.kind, unitId: u.id, allowedActions: decisions[2 * i + 1] ? [this.manageAction(u.kind)] : [] }]
        : [],
    );
    const rows = await this.prisma.membership.findMany({
      orderBy: { createdAt: 'asc' },
      select: { userId: true, divisionId: true, teamId: true, source: true, createdAt: true },
    });
    const items = rows.flatMap((r) => {
      const unitType: UnitKind = r.divisionId ? 'division' : 'team';
      const unitId = (r.divisionId ?? r.teamId) as string;
      if (!visible.has(this.unitKey(unitType, unitId))) return [];
      return [{ userId: r.userId, unitType, unitId, source: r.source, createdAt: r.createdAt }];
    });
    return { items, units: unitViews };
  }

  private manageAction(kind: UnitKind): string {
    return kind === 'division' ? ACTIONS.divisionManageMembers.action : ACTIONS.teamManageMembers.action;
  }

  /**
   * Apply the membership editor's staged changes all-or-nothing. Each unit touched is
   * authorized on its own (`division:manage_members` / `team:manage_members`), every
   * change is checked against what the editor saw, and the writes and their audit rows
   * land in one transaction. Membership carries no authority (ADR 0007), so the admin
   * floor doesn't apply.
   */
  async applyBatch(actorUserId: string, dto: BatchMembershipsDto): Promise<MembershipsView> {
    const { changes } = dto;
    const keys = changes.map((c) => `${this.unitKey(c.unitType, c.unitId)}|${c.userId}`);
    if (new Set(keys).size !== keys.length) {
      throw new ValidationError('A membership appears in more than one change', [
        { field: 'changes', message: 'Each person may be added to or removed from a unit once per save' },
      ]);
    }

    const units = await this.loadUnits();
    const touched = [...new Set(changes.map((c) => this.unitKey(c.unitType, c.unitId)))].map((k) => {
      const unit = units.get(k);
      if (!unit) {
        throw k.startsWith('division:')
          ? new NotFoundError('DIVISION_NOT_FOUND', 'Division not found')
          : new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
      }
      return unit;
    });
    const allowed = await this.access.decideMany(
      actorUserId,
      touched.map((u) => ({ action: this.manageAction(u.kind), resource: u.ref })),
    );
    if (allowed.some((ok) => !ok)) {
      throw new DeniedError('FORBIDDEN', 'You may not change the members of every unit in this save');
    }
    // Retired units accept no new members; removing from one is still allowed.
    for (const c of changes) {
      const unit = units.get(this.unitKey(c.unitType, c.unitId))!;
      if (c.op === 'add' && unit.lifecycleState === LifecycleState.retired) {
        throw c.unitType === 'division'
          ? new ConflictError('DIVISION_RETIRED', 'Division is retired')
          : new ConflictError('TEAM_RETIRED', 'Team is retired');
      }
    }

    const addedIds = [...new Set(changes.filter((c) => c.op === 'add').map((c) => c.userId))];
    const people = await this.prisma.appUser.findMany({
      where: { id: { in: addedIds } },
      select: { id: true, lifecycleState: true },
    });
    for (const id of addedIds) {
      const person = people.find((p) => p.id === id);
      if (!person) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
      if (person.lifecycleState === LifecycleState.retired) throw new ConflictError('USER_RETIRED', 'User is retired');
    }

    const stale = () =>
      new ConflictError('STALE_MEMBERSHIP', 'Someone else changed these memberships. Reload to see their changes.');
    await this.prisma.$transaction(async (tx) => {
      for (const c of changes) {
        const where = { userId: c.userId, ...this.unitWhere(c.unitType, c.unitId) };
        if (c.op === 'add') {
          if (await tx.membership.findFirst({ where, select: { id: true } })) throw stale();
          await tx.membership.create({ data: { ...where, grantedBy: actorUserId } });
        } else {
          const { count } = await tx.membership.deleteMany({ where });
          if (count === 0) throw stale();
        }
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: c.unitType,
          subjectId: c.unitId,
          verb: c.op === 'add' ? 'membership.added' : 'membership.removed',
          payload: { userId: c.userId, unitType: c.unitType, unitId: c.unitId },
        });
      }
    });
    return this.listAll(actorUserId);
  }

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
