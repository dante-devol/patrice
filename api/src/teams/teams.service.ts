import { Inject, Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, RoleKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { isRevivable } from '../common/lifecycle';
import { CreateTeamDto, UpdateTeamDto } from './teams.dto';

export interface TeamView {
  id: string;
  name: string;
  restrictClaims: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  inherentRoleId: string;
}

/**
 * Teams (Slice 2.2). Same inherent-role auto-creation + lifecycle-cascade contract
 * as divisions (`kind='team'`, UNIQUE `role.team_id` backstop), minus the openings
 * settings which live only on divisions.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
  ) {}

  async list(organizationId: string): Promise<TeamView[]> {
    const rows = await this.prisma.team.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      include: { inherentRole: true },
    });
    return rows.map((r) => this.toView(r));
  }

  private toView(
    r: Prisma.TeamGetPayload<{ include: { inherentRole: true } }>,
  ): TeamView {
    return {
      id: r.id,
      name: r.name,
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
    dto: CreateTeamDto,
  ): Promise<TeamView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          organizationId,
          name: dto.name,
          restrictClaims: dto.restrictClaims ?? false,
        },
      });
      const role = await tx.role.create({
        data: {
          organizationId,
          name: team.name,
          kind: RoleKind.team,
          teamId: team.id,
        },
        select: { id: true },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.created',
        payload: { teamId: team.id },
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
      return tx.team.findUniqueOrThrow({
        where: { id: team.id },
        include: { inherentRole: true },
      });
    });
    return this.toView(row);
  }

  private async load(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { inherentRole: true },
    });
    if (!team || !team.inherentRole) {
      throw new NotFoundError('TEAM_NOT_FOUND', 'Team not found');
    }
    return team;
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateTeamDto,
  ): Promise<TeamView> {
    const team = await this.load(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: team.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.restrictClaims !== undefined
            ? { restrictClaims: dto.restrictClaims }
            : {}),
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      if (dto.name !== undefined) {
        await tx.role.update({
          where: { id: team.inherentRole!.id },
          data: { name: dto.name, version: { increment: 1 } },
        });
      }
      await this.activity.logActivity({
        tx,
        organizationId: team.organizationId,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.updated',
        payload: { teamId: team.id },
      });
      return updated;
    });
    return this.toView(row);
  }

  async retire(id: string, actorUserId: string): Promise<TeamView> {
    const team = await this.load(id);
    if (team.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Team is already retired');
    }
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: team.id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      await tx.role.update({
        where: { id: team.inherentRole!.id },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: team.organizationId,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.retired',
        payload: { teamId: team.id },
      });
      await this.activity.logActivity({
        tx,
        organizationId: team.organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: team.inherentRole!.id,
        verb: 'role.retired',
        payload: { roleId: team.inherentRole!.id },
      });
      await this.access.bumpConfigVersion(team.organizationId, tx);
      return updated;
    });
    return this.toView(row);
  }

  async revive(id: string, actorUserId: string): Promise<TeamView> {
    const team = await this.load(id);
    if (!isRevivable(team, this.env.RETIREMENT_GRACE_DAYS)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Team is not retired or its grace period has elapsed',
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: team.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
        include: { inherentRole: true },
      });
      await tx.role.update({
        where: { id: team.inherentRole!.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: team.organizationId,
        actorUserId,
        subjectType: 'team',
        subjectId: team.id,
        verb: 'team.revived',
        payload: { teamId: team.id },
      });
      await this.activity.logActivity({
        tx,
        organizationId: team.organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: team.inherentRole!.id,
        verb: 'role.revived',
        payload: { roleId: team.inherentRole!.id },
      });
      await this.access.bumpConfigVersion(team.organizationId, tx);
      return updated;
    });
    return this.toView(row);
  }
}
