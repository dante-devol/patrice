import { Injectable } from '@nestjs/common';
import { LifecycleState } from '@prisma/client';
import { CedarEngine } from '../access/cedar/engine';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AdministrabilityService } from '../access/administrability.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, DeniedError, NotFoundError } from '../common/errors';
import { activeFilter } from '../common/lifecycle';
import { UpdateUserDto } from './users.dto';

export interface UserView {
  id: string;
  email: string | null;
  displayName: string;
  lifecycleState: LifecycleState;
  roleIds: string[];
}

/**
 * Users + membership (Slice 2.4). `user:grant_role` / `user:revoke_role` are scoped
 * by the *granted* role: the AuthorizeGuard checks the actor's authority at the
 * boundary, and these methods **re-validate at apply time** (privilege bounds must
 * not drift between guard and write). Revoking a role or deactivating a user can
 * empty the Effective Admin set, so those paths run under the admin-floor guard.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly admin: AdministrabilityService,
    private readonly activity: ActivityService,
  ) {}

  async list(organizationId: string, includeRetired = false): Promise<UserView[]> {
    const users = await this.prisma.appUser.findMany({
      where: { organizationId, ...activeFilter(includeRetired) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        displayName: true,
        lifecycleState: true,
        userRoles: { select: { roleId: true } },
      },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      lifecycleState: u.lifecycleState,
      roleIds: u.userRoles.map((r) => r.roleId),
    }));
  }

  private async loadUser(organizationId: string, id: string) {
    const user = await this.prisma.appUser.findFirst({
      where: { id, organizationId },
      select: { id: true, organizationId: true, lifecycleState: true },
    });
    if (!user) throw new NotFoundError('USER_NOT_FOUND', 'User not found');
    return user;
  }

  async update(
    organizationId: string,
    id: string,
    actorUserId: string,
    dto: UpdateUserDto,
  ): Promise<{ id: string; displayName: string }> {
    const user = await this.loadUser(organizationId, id);
    const updated = await this.prisma.appUser.update({
      where: { id: user.id },
      data: { displayName: dto.displayName, version: { increment: 1 } },
      select: { id: true, displayName: true },
    });
    await this.activity.logActivity({
      organizationId,
      actorUserId,
      subjectType: 'user',
      subjectId: user.id,
      verb: 'user.updated',
      payload: { userId: user.id },
    });
    return updated;
  }

  async deactivate(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    const user = await this.loadUser(organizationId, id);
    if (user.lifecycleState === LifecycleState.deactivated) return;
    await this.admin.withAdminFloor(
      organizationId,
      actorUserId,
      { type: 'user', id: user.id, path: 'user.deactivate' },
      async (tx) => {
        await tx.appUser.update({
          where: { id: user.id },
          data: {
            lifecycleState: LifecycleState.deactivated,
            deactivatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await this.activity.logActivity({
          tx,
          organizationId,
          actorUserId,
          subjectType: 'user',
          subjectId: user.id,
          verb: 'user.deactivated',
          payload: { userId: user.id },
        });
        await this.access.bumpConfigVersion(organizationId, tx);
      },
    );
  }

  async reactivate(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<void> {
    const user = await this.loadUser(organizationId, id);
    if (user.lifecycleState === LifecycleState.active) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.appUser.update({
        where: { id: user.id },
        data: {
          lifecycleState: LifecycleState.active,
          deactivatedAt: null,
          version: { increment: 1 },
        },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'user',
        subjectId: user.id,
        verb: 'user.reactivated',
        payload: { userId: user.id },
      });
      await this.access.bumpConfigVersion(organizationId, tx);
    });
  }

  /** Re-check the actor may grant/revoke the specific role (apply-time bound). */
  private async reauthorizeRoleScope(
    actorUserId: string,
    action: 'user:grant_role' | 'user:revoke_role',
    targetUserId: string,
    roleId: string,
  ): Promise<void> {
    const allowed = await this.access.decide({
      userId: actorUserId,
      action,
      resource: {
        type: 'User',
        id: targetUserId,
        attrs: {
          targetRole: {
            __entity: { type: CedarEngine.qualify('Role'), id: roleId },
          },
          retired: false,
        },
      },
    });
    if (!allowed) {
      throw new DeniedError('FORBIDDEN', `Not permitted to ${action} this role`);
    }
  }

  async grantRole(
    organizationId: string,
    targetUserId: string,
    roleId: string,
    actorUserId: string,
  ): Promise<void> {
    const user = await this.loadUser(organizationId, targetUserId);
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId },
      select: { id: true },
    });
    if (!role) throw new NotFoundError('ROLE_NOT_FOUND', 'Role not found');

    await this.reauthorizeRoleScope(
      actorUserId,
      'user:grant_role',
      user.id,
      roleId,
    );

    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: user.id, roleId } },
      select: { id: true },
    });
    if (existing) return; // idempotent

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.create({
        data: { userId: user.id, roleId, grantedBy: actorUserId },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'user',
        subjectId: user.id,
        verb: 'user_role.granted',
        payload: { userId: user.id, roleId },
      });
      await this.access.bumpConfigVersion(organizationId, tx);
    });
  }

  async revokeRole(
    organizationId: string,
    targetUserId: string,
    roleId: string,
    actorUserId: string,
  ): Promise<void> {
    const user = await this.loadUser(organizationId, targetUserId);
    await this.reauthorizeRoleScope(
      actorUserId,
      'user:revoke_role',
      user.id,
      roleId,
    );

    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId: user.id, roleId } },
      select: { id: true },
    });
    if (!existing) {
      throw new ConflictError('NOT_A_MEMBER', 'User does not hold that role');
    }

    await this.admin.withAdminFloor(
      organizationId,
      actorUserId,
      { type: 'user', id: user.id, path: 'user.revoke_role' },
      async (tx) => {
        await tx.userRole.delete({
          where: { userId_roleId: { userId: user.id, roleId } },
        });
        await this.activity.logActivity({
          tx,
          organizationId,
          actorUserId,
          subjectType: 'user',
          subjectId: user.id,
          verb: 'user_role.revoked',
          payload: { userId: user.id, roleId },
        });
        await this.access.bumpConfigVersion(organizationId, tx);
      },
    );
  }
}
