import { Injectable } from '@nestjs/common';
import { LifecycleState, RoleKind } from '@prisma/client';
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

export type RoleView = {
  id: string;
  name: string;
  /** `org`: held org-wide. `unit`: only ever assigned at a division or team. */
  kind: RoleKind;
  /** Unit roles: whether someone appointing through a unit role may assign it. */
  assignableByLeads: boolean;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Role CRUD + the retire ↔ revive state machine. A role's kind is fixed at creation:
 * `org` roles are held org-wide, `unit` roles are assigned at a division or team
 * (UnitRolesService) and their grants apply only there. Belonging to a unit is a
 * membership, not a role.
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
      data: {
        name: dto.name,
        kind: dto.kind ?? RoleKind.org,
        assignableByLeads: dto.kind === RoleKind.unit ? (dto.assignableByLeads ?? false) : false,
      },
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
    if (dto.assignableByLeads !== undefined && role.kind !== RoleKind.unit) {
      throw new UnprocessableError('NOT_A_UNIT_ROLE', 'Only a unit role can be assignable by leads');
    }
    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.assignableByLeads !== undefined ? { assignableByLeads: dto.assignableByLeads } : {}),
        version: { increment: 1 },
      },
    });
    // Who leads may appoint is read by the projected policies' resources, not the
    // policy text, so no config_version bump is needed.
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'role',
      subjectId: role.id,
      verb: 'role.updated',
      payload: { roleId: role.id, changes: diffFields(role, updated, ['name', 'assignableByLeads']) },
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
