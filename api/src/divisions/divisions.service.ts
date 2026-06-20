import { Inject, Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, RoleKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { isRevivable } from '../common/lifecycle';
import { CreateDivisionDto, UpdateDivisionDto } from './divisions.dto';

export interface DivisionView {
  id: string;
  name: string;
  defaultOpenings: number;
  openingsLocked: boolean;
  restrictClaims: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  inherentRoleId: string;
}

/**
 * Divisions (Slice 2.2). Each division atomically creates its **inherent role**
 * (`kind='division'`, `division_id` set, same name) — the UNIQUE on
 * `role.division_id` is the concurrency backstop. Retiring/reviving a division
 * cascades to its inherent role in the same transaction; that flips a projected
 * role's lifecycle, so a `config_version` bump + cache drop ride along.
 */
@Injectable()
export class DivisionsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
  ) {}

  async list(organizationId: string): Promise<DivisionView[]> {
    const rows = await this.prisma.division.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { inherentRole: true },
    });
    return rows.map((r) => this.toView(r));
  }

  private toView(
    r: Prisma.DivisionGetPayload<{ include: { inherentRole: true } }>,
  ): DivisionView {
    return {
      id: r.id,
      name: r.name,
      defaultOpenings: r.defaultOpenings,
      openingsLocked: r.openingsLocked,
      restrictClaims: r.restrictClaims,
      lifecycleState: r.lifecycleState,
      retiredAt: r.retiredAt,
      version: r.version,
      inherentRoleId: r.inherentRole!.id,
    };
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: CreateDivisionDto,
  ): Promise<DivisionView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const division = await tx.division.create({
        data: {
          organizationId,
          name: dto.name,
          defaultOpenings: dto.defaultOpenings ?? 1,
          openingsLocked: dto.openingsLocked ?? false,
          restrictClaims: dto.restrictClaims ?? false,
        },
      });
      const role = await tx.role.create({
        data: {
          organizationId,
          name: division.name,
          kind: RoleKind.division,
          divisionId: division.id,
        },
        select: { id: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'division',
        subjectId: division.id,
        verb: 'division.created',
        payload: { divisionId: division.id },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: role.id,
        verb: 'role.created',
        payload: { roleId: role.id },
      });
      return tx.division.findUniqueOrThrow({
        where: { id: division.id },
        include: { inherentRole: true },
      });
    });
    return this.toView(row);
  }

  private async load(id: string) {
    const division = await this.prisma.division.findUnique({
      where: { id },
      include: { inherentRole: true },
    });
    if (!division || !division.inherentRole) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }
    return division;
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateDivisionDto,
  ): Promise<DivisionView> {
    const division = await this.load(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.division.update({
        where: { id: division.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.defaultOpenings !== undefined
            ? { defaultOpenings: dto.defaultOpenings }
            : {}),
          ...(dto.openingsLocked !== undefined
            ? { openingsLocked: dto.openingsLocked }
            : {}),
          ...(dto.restrictClaims !== undefined
            ? { restrictClaims: dto.restrictClaims }
            : {}),
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      // Keep the inherent role's name in lock-step with its division.
      if (dto.name !== undefined) {
        await tx.role.update({
          where: { id: division.inherentRole!.id },
          data: { name: dto.name, version: { increment: 1 } },
        });
      }
      await this.activity.logActivity({
        tx,
        organizationId: division.organizationId,
        actorUserId,
        subjectType: 'division',
        subjectId: division.id,
        verb: 'division.updated',
        payload: { divisionId: division.id },
      });
      return updated;
    });
    return this.toView(row);
  }

  async retire(id: string, actorUserId: string): Promise<DivisionView> {
    const division = await this.load(id);
    if (division.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Division is already retired');
    }
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.division.update({
        where: { id: division.id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      await tx.role.update({
        where: { id: division.inherentRole!.id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: division.organizationId,
        actorUserId,
        subjectType: 'division',
        subjectId: division.id,
        verb: 'division.retired',
        payload: { divisionId: division.id },
      });
      await this.activity.logActivity({
        tx,
        organizationId: division.organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: division.inherentRole!.id,
        verb: 'role.retired',
        payload: { roleId: division.inherentRole!.id },
      });
      await this.access.bumpConfigVersion(division.organizationId, tx);
      return updated;
    });
    return this.toView(row);
  }

  async revive(id: string, actorUserId: string): Promise<DivisionView> {
    const division = await this.load(id);
    if (!isRevivable(division, this.env.RETIREMENT_GRACE_DAYS)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Division is not retired or its grace period has elapsed',
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.division.update({
        where: { id: division.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      await tx.role.update({
        where: { id: division.inherentRole!.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: division.organizationId,
        actorUserId,
        subjectType: 'division',
        subjectId: division.id,
        verb: 'division.revived',
        payload: { divisionId: division.id },
      });
      await this.activity.logActivity({
        tx,
        organizationId: division.organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: division.inherentRole!.id,
        verb: 'role.revived',
        payload: { roleId: division.inherentRole!.id },
      });
      await this.access.bumpConfigVersion(division.organizationId, tx);
      return updated;
    });
    return this.toView(row);
  }
}
