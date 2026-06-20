import { Inject, Injectable } from '@nestjs/common';
import { LifecycleState, RoleKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AdministrabilityService } from '../access/administrability.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { isRevivable } from '../common/lifecycle';
import { CreateRoleDto, UpdateRoleDto } from './roles.dto';

export interface RoleView {
  id: string;
  organizationId: string;
  name: string;
  kind: RoleKind;
  divisionId: string | null;
  teamId: string | null;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Standalone-role CRUD + the retire ↔ revive state machine (Slice 2.1). Inherent
 * roles (`kind='division'|'team'`) are created/retired/revived through their parent
 * division/team (Slice 2.2) — direct lifecycle edits here are refused with 422.
 *
 * Retire/revive flip a role's `lifecycle_state`, which the access projector reads
 * (`role.lifecycleState='active'`), so each bumps `config_version` and drops the
 * projection cache in the same transaction.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly admin: AdministrabilityService,
    private readonly activity: ActivityService,
  ) {}

  private toView(r: RoleView): RoleView {
    return r;
  }

  async list(organizationId: string): Promise<RoleView[]> {
    return this.prisma.role.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: CreateRoleDto,
  ): Promise<RoleView> {
    const role = await this.prisma.role.create({
      data: {
        organizationId,
        name: dto.name,
        kind: RoleKind.standalone,
      },
    });
    await this.activity.logActivity({
      organizationId,
      actorUserId,
      subjectType: 'role',
      subjectId: role.id,
      verb: 'role.created',
      payload: { roleId: role.id },
    });
    // A standalone role with no grants attached does not affect the projected
    // policy set (acceptance #8) — no config_version bump needed on create.
    return this.toView(role);
  }

  /** Load a standalone role or throw (404 missing, 422 if inherent). */
  private async loadStandalone(id: string): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
    if (role.kind !== RoleKind.standalone) {
      throw new ValidationError(
        'Inherent roles are managed through their division or team',
        [{ field: 'id', message: 'Not a standalone role' }],
      );
    }
    return role;
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateRoleDto,
  ): Promise<RoleView> {
    const role = await this.loadStandalone(id);
    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: { name: dto.name, version: { increment: 1 } },
    });
    await this.activity.logActivity({
      organizationId: role.organizationId,
      actorUserId,
      subjectType: 'role',
      subjectId: role.id,
      verb: 'role.updated',
      payload: { roleId: role.id },
    });
    return this.toView(updated);
  }

  async retire(id: string, actorUserId: string): Promise<RoleView> {
    const role = await this.loadStandalone(id);
    if (role.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Role is already retired');
    }
    // Retiring a role drops its grants from the projection — if it carried the last
    // global governance grant, the admin floor would hit zero. Guarded.
    const updated = await this.admin.withAdminFloor(
      role.organizationId,
      actorUserId,
      { type: 'role', id: role.id, path: 'role.retire' },
      async (tx) => {
        const r = await tx.role.update({
          where: { id: role.id },
          data: {
            lifecycleState: LifecycleState.retired,
            retiredAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.activity.logActivity({
          tx,
          organizationId: role.organizationId,
          actorUserId,
          subjectType: 'role',
          subjectId: role.id,
          verb: 'role.retired',
          payload: { roleId: role.id },
        });
        await this.access.bumpConfigVersion(role.organizationId, tx);
        return r;
      },
    );
    return this.toView(updated);
  }

  async revive(id: string, actorUserId: string): Promise<RoleView> {
    const role = await this.loadStandalone(id);
    if (!isRevivable(role, this.env.RETIREMENT_GRACE_DAYS)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Role is not retired or its grace period has elapsed',
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const r = await tx.role.update({
        where: { id: role.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId: role.organizationId,
        actorUserId,
        subjectType: 'role',
        subjectId: role.id,
        verb: 'role.revived',
        payload: { roleId: role.id },
      });
      await this.access.bumpConfigVersion(role.organizationId, tx);
      return r;
    });
    return this.toView(updated);
  }
}
