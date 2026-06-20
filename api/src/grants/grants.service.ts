import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GrantEffect, LifecycleState, Prisma, ScopeKind } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AdministrabilityService } from '../access/administrability.service';
import { CedarEngine } from '../access/cedar/engine';
import { ActivityService } from '../activity/activity.service';
import { ALL_ACTION_STRINGS, RESOURCE_TYPE_BY_ACTION } from '../access/actions';
import {
  ProjectableGrant,
  grantToPolicy,
  staticPolicies,
} from '../access/cedar/policies';

/** Resource types whose entities carry a `division`/`team` (group-scopable). */
const GROUP_SCOPABLE = new Set(['Task', 'Message', 'Attachment']);
/** Resource types whose entities carry a `targetRole` (role-scope). */
const ROLE_SCOPABLE = new Set(['User']);
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { isRevivable } from '../common/lifecycle';
import { CreateGrantDto, UpdateGrantDto } from './grants.dto';

export interface GrantView {
  id: string;
  roleId: string;
  action: string;
  effect: GrantEffect;
  scopeKind: ScopeKind;
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
  lifecycleState: LifecycleState;
  retiredAt: Date | null;
  version: number;
}

interface ScopeFields {
  scopeKind: ScopeKind | string;
  scopeDivisionId?: string | null;
  scopeTeamId?: string | null;
  scopeRoleId?: string | null;
}

/**
 * Grants = permission-matrix cells (Slice 2.3). Every write **validates before it
 * activates**: the candidate grant is projected with the rest of the active set and
 * schema-validated; a structurally impossible action/scope combination is refused
 * `422` and never written. Each successful write bumps `config_version` and drops
 * the projection cache so the next request re-projects against the new matrix.
 */
@Injectable()
export class GrantsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly admin: AdministrabilityService,
    private readonly cedar: CedarEngine,
    private readonly activity: ActivityService,
  ) {}

  /** The closed action vocabulary, for the matrix UI. */
  listActions(): readonly string[] {
    return ALL_ACTION_STRINGS;
  }

  async list(organizationId: string): Promise<GrantView[]> {
    return this.prisma.grant.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
      select: this.viewSelect(),
    });
  }

  private viewSelect() {
    return {
      id: true,
      roleId: true,
      action: true,
      effect: true,
      scopeKind: true,
      scopeDivisionId: true,
      scopeTeamId: true,
      scopeRoleId: true,
      lifecycleState: true,
      retiredAt: true,
      version: true,
    } satisfies Prisma.GrantSelect;
  }

  /** Structural pre-checks before the heavier Cedar validation. 422 on failure. */
  private assertShape(action: string, scope: ScopeFields): void {
    if (!ALL_ACTION_STRINGS.includes(action)) {
      throw new ValidationError(`Unknown action "${action}"`, [
        { field: 'action', message: 'Not in the action vocabulary' },
      ]);
    }
    const { scopeKind, scopeDivisionId, scopeTeamId, scopeRoleId } = scope;
    const resourceType = RESOURCE_TYPE_BY_ACTION[action];
    const need = (cond: boolean, field: string, message: string) => {
      if (!cond) throw new ValidationError(message, [{ field, message }]);
    };
    const groupScopable = () =>
      need(
        GROUP_SCOPABLE.has(resourceType),
        'scopeKind',
        `Action "${action}" applies to ${resourceType}, which has no division/team to scope by`,
      );
    switch (scopeKind) {
      case 'specific_division':
        need(!!scopeDivisionId, 'scopeDivisionId', 'specific_division requires a division');
        need(!scopeTeamId && !scopeRoleId, 'scope', 'Only scopeDivisionId is allowed here');
        groupScopable();
        break;
      case 'specific_team':
        need(!!scopeTeamId, 'scopeTeamId', 'specific_team requires a team');
        need(!scopeDivisionId && !scopeRoleId, 'scope', 'Only scopeTeamId is allowed here');
        groupScopable();
        break;
      case 'own_division':
      case 'own_team':
        need(
          !scopeDivisionId && !scopeTeamId && !scopeRoleId,
          'scope',
          `${scopeKind} scope takes no scope id`,
        );
        groupScopable();
        break;
      case 'role':
        need(!!scopeRoleId, 'scopeRoleId', 'role scope requires a target role');
        need(!scopeDivisionId && !scopeTeamId, 'scope', 'Only scopeRoleId is allowed here');
        need(
          ROLE_SCOPABLE.has(resourceType),
          'scopeKind',
          `Action "${action}" cannot be scoped by role`,
        );
        break;
      case 'global':
      case 'own':
        need(
          !scopeDivisionId && !scopeTeamId && !scopeRoleId,
          'scope',
          `${scopeKind} scope takes no scope id`,
        );
        break;
    }
  }

  /** Project static + all active grants, substituting the candidate, then validate. */
  private async validateActivation(
    organizationId: string,
    candidate: ProjectableGrant,
    excludeGrantId?: string,
  ): Promise<void> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    const selfReviewAllowed =
      (org.settings as Record<string, unknown>)?.selfReviewAllowed === true;

    const active = await this.prisma.grant.findMany({
      where: {
        organizationId,
        lifecycleState: 'active',
        role: { lifecycleState: 'active' },
        ...(excludeGrantId ? { id: { not: excludeGrantId } } : {}),
      },
      select: {
        id: true,
        roleId: true,
        action: true,
        effect: true,
        scopeKind: true,
        scopeDivisionId: true,
        scopeTeamId: true,
        scopeRoleId: true,
      },
    });

    let policiesText: string;
    try {
      const grantPolicies = [...active.map((g) => g as ProjectableGrant), candidate].map(
        (g) => grantToPolicy(g),
      );
      const statics = staticPolicies({
        selfReviewAllowed,
        registeredActions: ALL_ACTION_STRINGS,
      });
      policiesText = [...statics, ...grantPolicies].join('\n\n');
    } catch (e) {
      // grantToPolicy throws for an `own` grant on an action with no owner relation.
      throw new ValidationError(
        `Grant cannot be projected: ${(e as Error).message}`,
        [{ field: 'scopeKind', message: 'Unsupported action/scope combination' }],
      );
    }

    const errors = this.cedar.validationErrors(policiesText);
    if (errors.length > 0) {
      throw new ValidationError('Grant fails Cedar schema validation', [
        { field: 'scopeKind', message: errors[0] },
      ]);
    }
  }

  /** Confirm the granted role exists and is active (422 otherwise). */
  private async assertRole(organizationId: string, roleId: string): Promise<void> {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, organizationId },
      select: { lifecycleState: true },
    });
    if (!role) {
      throw new ValidationError('Unknown role', [
        { field: 'roleId', message: 'Role not found' },
      ]);
    }
  }

  async create(
    organizationId: string,
    actorUserId: string,
    dto: CreateGrantDto,
  ): Promise<GrantView> {
    this.assertShape(dto.action, dto);
    await this.assertRole(organizationId, dto.roleId);

    const candidate: ProjectableGrant = {
      id: randomUUID(),
      roleId: dto.roleId,
      action: dto.action,
      effect: dto.effect,
      scopeKind: dto.scopeKind,
      scopeDivisionId: dto.scopeDivisionId ?? null,
      scopeTeamId: dto.scopeTeamId ?? null,
      scopeRoleId: dto.scopeRoleId ?? null,
    };
    await this.validateActivation(organizationId, candidate);

    const grant = await this.prisma.$transaction(async (tx) => {
      const g = await tx.grant.create({
        data: {
          organizationId,
          roleId: dto.roleId,
          action: dto.action,
          effect: dto.effect as GrantEffect,
          scopeKind: dto.scopeKind as ScopeKind,
          scopeDivisionId: dto.scopeDivisionId ?? null,
          scopeTeamId: dto.scopeTeamId ?? null,
          scopeRoleId: dto.scopeRoleId ?? null,
        },
        select: this.viewSelect(),
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'grant',
        subjectId: g.id,
        verb: 'grant.created',
        payload: { grantId: g.id, roleId: g.roleId },
      });
      await this.access.bumpConfigVersion(organizationId, tx);
      return g;
    });
    return grant;
  }

  private async load(id: string) {
    const grant = await this.prisma.grant.findUnique({
      where: { id },
      select: { ...this.viewSelect(), organizationId: true },
    });
    if (!grant) throw new NotFoundError('GRANT_NOT_FOUND', 'Grant not found');
    return grant;
  }

  async update(
    id: string,
    actorUserId: string,
    dto: UpdateGrantDto,
  ): Promise<GrantView> {
    const existing = await this.load(id);
    const merged = {
      action: dto.action ?? existing.action,
      effect: (dto.effect ?? existing.effect) as GrantEffect,
      scopeKind: (dto.scopeKind ?? existing.scopeKind) as ScopeKind,
      // A scope-kind change clears the now-irrelevant ids unless explicitly given.
      scopeDivisionId:
        dto.scopeDivisionId !== undefined
          ? dto.scopeDivisionId
          : dto.scopeKind
            ? null
            : existing.scopeDivisionId,
      scopeTeamId:
        dto.scopeTeamId !== undefined
          ? dto.scopeTeamId
          : dto.scopeKind
            ? null
            : existing.scopeTeamId,
      scopeRoleId:
        dto.scopeRoleId !== undefined
          ? dto.scopeRoleId
          : dto.scopeKind
            ? null
            : existing.scopeRoleId,
    };
    this.assertShape(merged.action, merged);

    const candidate: ProjectableGrant = {
      id: existing.id,
      roleId: existing.roleId,
      ...merged,
      scopeDivisionId: merged.scopeDivisionId ?? null,
      scopeTeamId: merged.scopeTeamId ?? null,
      scopeRoleId: merged.scopeRoleId ?? null,
    };
    await this.validateActivation(existing.organizationId, candidate, existing.id);

    // Editing a governance grant can revoke admin authority — guard the floor.
    const grant = await this.admin.withAdminFloor(
      existing.organizationId,
      actorUserId,
      { type: 'grant', id: existing.id, path: 'grant.update' },
      async (tx) => {
        const g = await tx.grant.update({
          where: { id: existing.id },
          data: {
            action: merged.action,
            effect: merged.effect,
            scopeKind: merged.scopeKind,
            scopeDivisionId: merged.scopeDivisionId ?? null,
            scopeTeamId: merged.scopeTeamId ?? null,
            scopeRoleId: merged.scopeRoleId ?? null,
            version: { increment: 1 },
          },
          select: this.viewSelect(),
        });
        await this.activity.logActivity({
          tx,
          organizationId: existing.organizationId,
          actorUserId,
          subjectType: 'grant',
          subjectId: g.id,
          verb: 'grant.updated',
          payload: { grantId: g.id, roleId: g.roleId },
        });
        await this.access.bumpConfigVersion(existing.organizationId, tx);
        return g;
      },
    );
    return grant;
  }

  async retire(id: string, actorUserId: string): Promise<GrantView> {
    const existing = await this.load(id);
    if (existing.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Grant is already retired');
    }
    const grant = await this.admin.withAdminFloor(
      existing.organizationId,
      actorUserId,
      { type: 'grant', id: existing.id, path: 'grant.retire' },
      async (tx) => {
        const g = await tx.grant.update({
          where: { id: existing.id },
          data: {
            lifecycleState: LifecycleState.retired,
            retiredAt: new Date(),
            version: { increment: 1 },
          },
          select: this.viewSelect(),
        });
        await this.activity.logActivity({
          tx,
          organizationId: existing.organizationId,
          actorUserId,
          subjectType: 'grant',
          subjectId: g.id,
          verb: 'grant.retired',
          payload: { grantId: g.id, roleId: g.roleId },
        });
        await this.access.bumpConfigVersion(existing.organizationId, tx);
        return g;
      },
    );
    return grant;
  }

  async revive(id: string, actorUserId: string): Promise<GrantView> {
    const existing = await this.load(id);
    if (!isRevivable(existing, this.env.RETIREMENT_GRACE_DAYS)) {
      throw new ConflictError(
        'NOT_REVIVABLE',
        'Grant is not retired or its grace period has elapsed',
      );
    }
    const grant = await this.prisma.$transaction(async (tx) => {
      const g = await tx.grant.update({
        where: { id: existing.id },
        data: {
          lifecycleState: LifecycleState.active,
          retiredAt: null,
          version: { increment: 1 },
        },
        select: this.viewSelect(),
      });
      await this.activity.logActivity({
        tx,
        organizationId: existing.organizationId,
        actorUserId,
        subjectType: 'grant',
        subjectId: g.id,
        verb: 'grant.revived',
        payload: { grantId: g.id, roleId: g.roleId },
      });
      await this.access.bumpConfigVersion(existing.organizationId, tx);
      return g;
    });
    return grant;
  }
}
