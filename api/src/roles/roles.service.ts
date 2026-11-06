import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AdministrabilityService } from '../access/administrability.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import { ACTIONS } from '../access/actions';
import { diffFields } from '../activity/changes';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { CreateRoleDto, UpdateRoleDto } from './roles.dto';

export interface RoleView {
  id: string;
  name: string;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Role CRUD + the retire ↔ revive state machine. Roles carry no unit: belonging
 * to a division or team is a membership.
 *
 * Retire/revive flip a role's `lifecycle_state`, which the access projector reads
 * (`role.lifecycleState='active'`), so each bumps `config_version` and drops the
 * projection cache in the same transaction.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly admin: AdministrabilityService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
  ) {}

  private toView(r: RoleView): RoleView {
    return r;
  }

  /** The roles the user may see (`role:read`). */
  async list(userId: string, includeRetired = false): Promise<RoleView[]> {
    const rows = await this.prisma.role.findMany({
      where: { ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
    });
    return this.access.filterAllowed(userId, ACTIONS.roleRead.action, rows, (r) => ({
      type: 'Role',
      id: r.id,
      attrs: { targetRole: { __entity: { type: 'Patrice::Role', id: r.id } } },
    }));
  }

  async create(
    actorUserId: string,
    dto: CreateRoleDto,
  ): Promise<RoleView> {
    const role = await this.prisma.role.create({
      data: { name: dto.name },
    });
    await this.activity.logActivity({
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
  private async load(id: string): Promise<RoleView> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');
    return role;
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateRoleDto,
  ): Promise<RoleView> {
    const role = await this.load(id);
    if (role.lifecycleState === LifecycleState.retired) {
      throw new UnprocessableError('ROLE_RETIRED', 'Role is retired');
    }
    // Version-guarded when the client says which version it edited.
    const { count } = await this.prisma.role.updateMany({
      where: { id: role.id, ...(dto.version !== undefined ? { version: dto.version } : {}) },
      data: { name: dto.name, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new ConflictError('STALE_VERSION', 'The role changed since it was read; reload and retry');
    }
    const updated = await this.prisma.role.findUniqueOrThrow({ where: { id: role.id } });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'role',
      subjectId: role.id,
      verb: 'role.updated',
      payload: { roleId: role.id, changes: diffFields(role, updated, ['name']) },
    });
    return this.toView(updated);
  }

  async retire(id: string, actorUserId: string): Promise<RoleView> {
    const role = await this.load(id);
    if (role.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Role is already retired');
    }
    // Retiring a role drops its grants from the projection — if it carried the last
    // global governance grant, the admin floor would hit zero. Guarded.
    const updated = await this.admin.withAdminFloor(
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
          actorUserId,
          subjectType: 'role',
          subjectId: role.id,
          verb: 'role.retired',
          payload: { roleId: role.id },
        });
        await this.access.bumpConfigVersion(tx);
        return r;
      },
    );
    return this.toView(updated);
  }

  async revive(id: string, actorUserId: string): Promise<RoleView> {
    const role = await this.load(id);
    const graceMs = await this.grace.windowMs();
    if (!isRevivable(role, graceMs)) {
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
        actorUserId,
        subjectType: 'role',
        subjectId: role.id,
        verb: 'role.revived',
        payload: { roleId: role.id },
      });
      await this.access.bumpConfigVersion(tx);
      return r;
    });
    return this.toView(updated);
  }
}
