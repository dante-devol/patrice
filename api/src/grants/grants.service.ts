import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { GrantEffect, LifecycleState, Prisma, ScopeKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AccessService } from '../access/access.service';
import { AdministrabilityService } from '../access/administrability.service';
import { CedarEngine } from '../access/cedar/engine';
import { ActivityService } from '../activity/activity.service';
import { ACTIONS, ALL_ACTION_STRINGS, EFFECTIVE_ADMIN_ACTIONS, RESOURCE_TYPE_BY_ACTION, TASK_FAMILY_ACTIONS } from '../access/actions';
import { ORGANIZATION_RESOURCE } from '../access/access.service';
import {
  ProjectableGrant,
  grantToPolicy,
  ownRelation,
  staticPolicies,
} from '../access/cedar/policies';

/** Resource types whose entities carry a `division`/`team` (group-scopable). */
const GROUP_SCOPABLE = new Set(['Task', 'Message', 'Attachment', 'Division']);
/** Resource types whose entities carry a `targetRole` (role-scope). */
const ROLE_SCOPABLE = new Set(['User']);
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../common/errors';
import { GraceService } from '../common/grace.service';
import { activeFilter, isRevivable } from '../common/lifecycle';
import { CreateGrantDto, UpdateGrantDto, BatchGrantsDto } from './grants.dto';

/** One action as the permission editor sees it: its scopes, and what `own` checks. */
export interface ActionInfo {
  action: string;
  resourceType: string;
  scopes: ScopeKind[];
  own: string | null;
}

export interface GrantView {
  id: string;
  roleId: string;
  action: string;
  effect: GrantEffect;
  scopeKind: ScopeKind;
  scopeDivisionId: string | null;
  scopeTeamId: string | null;
  scopeRoleId: string | null;
  version: number;
}

interface ScopeFields {
  scopeKind: ScopeKind | string;
  scopeDivisionId?: string | null;
  scopeTeamId?: string | null;
  scopeRoleId?: string | null;
}

/**
 * Grants = permission-matrix cells. Every write **validates before it
 * activates**: the candidate grant is projected with the rest of the active set and
 * schema-validated; a structurally impossible action/scope combination is refused
 * `422` and never written. Each successful write bumps `config_version` and drops
 * the projection cache so the next request re-projects against the new matrix.
 */
@Injectable()
export class GrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly admin: AdministrabilityService,
    private readonly cedar: CedarEngine,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
  ) {}

  /** The closed action vocabulary, for the matrix UI. */
  /**
   * The vocabulary with each action's assignable scopes — the same rules `assertShape`
   * and the projector enforce, so the editor only offers scopes that can be saved.
   */
  actionCatalog(): ActionInfo[] {
    return ALL_ACTION_STRINGS.map((action) => {
      const resourceType = RESOURCE_TYPE_BY_ACTION[action];
      const own = ownRelation(action);
      const scopes: ScopeKind[] = ['global'];
      if (GROUP_SCOPABLE.has(resourceType)) {
        scopes.push('own_division', 'own_team', 'specific_division', 'specific_team');
      }
      if (ROLE_SCOPABLE.has(resourceType)) scopes.push('role');
      if (own) scopes.push('own');
      return { action, resourceType, scopes, own };
    });
  }

  listActions(): readonly string[] {
    return ALL_ACTION_STRINGS;
  }

  async list(): Promise<GrantView[]> {
    return this.prisma.grant.findMany({
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
    candidates: ProjectableGrant | ProjectableGrant[],
    exclude?: string | string[],
  ): Promise<void> {
    const candidate = [candidates].flat();
    const excludeIds = exclude === undefined ? [] : [exclude].flat();
    const { selfReviewAllowed, requireDiscordLink } = await this.settings.get();

    const active = await this.prisma.grant.findMany({
      where: {
        role: { lifecycleState: 'active' },
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
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
      const grantPolicies = [...active.map((g) => g as ProjectableGrant), ...candidate].map(
        (g) => grantToPolicy(g),
      );
      const statics = staticPolicies({
        selfReviewAllowed,
        registeredActions: ALL_ACTION_STRINGS,
        discordGatedActions: requireDiscordLink ? TASK_FAMILY_ACTIONS : [],
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
  /**
   * Native-Authority Carve-Out, grant side (problems D4): a governance permit can't
   * go to a role that an integration grants (mapped inbound or bidirectional), or
   * whoever controls the external group could make admins. The mapping side refuses
   * mapping a role that already holds one.
   */
  private async assertNotGovernanceToMappedRole(roleId: string, action: string, effect: string): Promise<void> {
    if (effect !== 'permit' || !EFFECTIVE_ADMIN_ACTIONS.includes(action)) return;
    const mapped = await this.prisma.externalGroupMapping.findFirst({
      where: { roleId, syncDirection: { in: ['inbound', 'bidirectional'] } },
      select: { id: true },
    });
    if (mapped) {
      throw new UnprocessableError(
        'GOVERNANCE_ROLE_MAPPED',
        'This role is granted by an integration, so it cannot hold governance actions',
      );
    }
  }

  private async assertRole(roleId: string): Promise<void> {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId },
      select: { lifecycleState: true },
    });
    if (!role) {
      throw new ValidationError('Unknown role', [
        { field: 'roleId', message: 'Role not found' },
      ]);
    }
    // Retired things accept no new references.
    if (role.lifecycleState === 'retired') {
      throw new UnprocessableError('ROLE_RETIRED', 'Role is retired');
    }
  }

  async create(
    actorUserId: string,
    dto: CreateGrantDto,
  ): Promise<GrantView> {
    this.assertShape(dto.action, dto);
    await this.assertRole(dto.roleId);
    await this.assertNotGovernanceToMappedRole(dto.roleId, dto.action, dto.effect);

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
    await this.validateActivation(candidate);

    // A new grant can take authority away (a forbid), so it runs under the admin floor.
    const grant = await this.admin.withAdminFloor(
      actorUserId,
      { type: 'grant', id: dto.roleId, path: 'grant.create' },
      async (tx) => {
        const g = await tx.grant.create({
          data: {
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
          actorUserId,
          subjectType: 'grant',
          subjectId: g.id,
          verb: 'grant.created',
          payload: { grantId: g.id, roleId: g.roleId },
        });
        await this.access.bumpConfigVersion(tx);
        return g;
      },
    );
    return grant;
  }

  private async load(id: string) {
    const grant = await this.prisma.grant.findUnique({
      where: { id },
      select: { ...this.viewSelect() },
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
    await this.assertNotGovernanceToMappedRole(existing.roleId, merged.action, merged.effect);

    const candidate: ProjectableGrant = {
      id: existing.id,
      roleId: existing.roleId,
      ...merged,
      scopeDivisionId: merged.scopeDivisionId ?? null,
      scopeTeamId: merged.scopeTeamId ?? null,
      scopeRoleId: merged.scopeRoleId ?? null,
    };
    await this.validateActivation(candidate, existing.id);

    // Editing a governance grant can revoke admin authority — guard the floor.
    const grant = await this.admin.withAdminFloor(
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
          actorUserId,
          subjectType: 'grant',
          subjectId: g.id,
          verb: 'grant.updated',
          payload: { grantId: g.id, roleId: g.roleId, before: grantShape(existing), after: grantShape(g) },
        });
        await this.access.bumpConfigVersion(tx);
        return g;
      },
    );
    return grant;
  }

  /**
   * Delete a grant permanently (`grant:delete`). Removing authority can strip the
   * last admin, so it runs under the admin floor. The audit row keeps the grant's
   * shape, so what was removed stays answerable.
   */
  async delete(id: string, actorUserId: string): Promise<void> {
    const existing = await this.load(id);
    await this.admin.withAdminFloor(
      actorUserId,
      { type: 'grant', id: existing.id, path: 'grant.delete' },
      async (tx) => {
        await tx.grant.delete({ where: { id: existing.id } });
        await this.activity.logActivity({
          tx,
          actorUserId,
          subjectType: 'grant',
          subjectId: existing.id,
          verb: 'grant.deleted',
          payload: { grantId: existing.id, roleId: existing.roleId, ...grantShape(existing) },
        });
        await this.access.bumpConfigVersion(tx);
      },
    );
  }

  /**
   * Apply the permission editor's staged changes all-or-nothing: each change is
   * shape-checked, the resulting matrix is validated as one set, and the writes land
   * in one admin-floor-guarded transaction with one config_version bump. A stale
   * `version` on any update or delete refuses the whole batch (409 STALE_GRANT).
   */
  async applyBatch(actorUserId: string, dto: BatchGrantsDto): Promise<GrantView[]> {
    const { changes } = dto;

    // The route is gated on grant:update; creates and deletes need their own action.
    for (const action of new Set(changes.map((c) => BATCH_ACTION[c.op]))) {
      await this.access.assert(actorUserId, action, ORGANIZATION_RESOURCE);
    }

    const touchedIds = changes.flatMap((c) => (c.op === 'create' ? [] : [c.id]));
    if (new Set(touchedIds).size !== touchedIds.length) {
      throw new ValidationError('A grant appears in more than one change', [
        { field: 'changes', message: 'Each grant may be changed once per batch' },
      ]);
    }
    const existing = await this.prisma.grant.findMany({ where: { id: { in: touchedIds } }, select: this.viewSelect() });
    const byId = new Map(existing.map((g) => [g.id, g]));
    for (const c of changes) {
      if (c.op === 'create') continue;
      const g = byId.get(c.id);
      if (!g) throw new NotFoundError('GRANT_NOT_FOUND', 'Grant not found');
      if (g.version !== c.version) {
        throw new ConflictError('STALE_GRANT', 'Someone else changed these permissions. Reload to see their changes.');
      }
    }
    for (const roleId of new Set(changes.flatMap((c) => (c.op === 'create' ? [c.roleId] : [])))) {
      await this.assertRole(roleId);
    }

    // The post-batch shape of every created or updated grant, for one validation pass.
    const candidates: ProjectableGrant[] = [];
    for (const c of changes) {
      if (c.op === 'delete') continue;
      const base =
        c.op === 'create'
          ? { id: randomUUID(), roleId: c.roleId, action: c.action, effect: c.effect }
          : (() => {
              const g = byId.get(c.id)!;
              return { id: g.id, roleId: g.roleId, action: g.action, effect: c.effect ?? g.effect };
            })();
      const candidate: ProjectableGrant = {
        ...base,
        scopeKind: c.scopeKind,
        scopeDivisionId: c.scopeDivisionId ?? null,
        scopeTeamId: c.scopeTeamId ?? null,
        scopeRoleId: c.scopeRoleId ?? null,
      };
      this.assertShape(candidate.action, candidate);
      await this.assertNotGovernanceToMappedRole(candidate.roleId, candidate.action, candidate.effect);
      candidates.push(candidate);
    }
    await this.validateActivation(candidates, touchedIds);

    await this.admin.withAdminFloor(
      actorUserId,
      { type: 'grant', id: randomUUID(), path: 'grant.batch' },
      async (tx) => {
        let i = 0;
        for (const c of changes) {
          if (c.op === 'create') {
            const cand = candidates[i++];
            const g = await tx.grant.create({
              data: {
                roleId: cand.roleId,
                action: cand.action,
                effect: cand.effect as GrantEffect,
                scopeKind: cand.scopeKind as ScopeKind,
                scopeDivisionId: cand.scopeDivisionId,
                scopeTeamId: cand.scopeTeamId,
                scopeRoleId: cand.scopeRoleId,
              },
              select: { id: true, roleId: true },
            });
            await this.activity.logActivity({
              tx,
              actorUserId,
              subjectType: 'grant',
              subjectId: g.id,
              verb: 'grant.created',
              payload: { grantId: g.id, roleId: g.roleId },
            });
            continue;
          }
          const before = byId.get(c.id)!;
          if (c.op === 'delete') {
            // Version-guarded: a concurrent write since the pre-check rolls the batch back.
            const res = await tx.grant.deleteMany({ where: { id: c.id, version: c.version } });
            if (res.count !== 1) {
              throw new ConflictError('STALE_GRANT', 'Someone else changed these permissions. Reload to see their changes.');
            }
            await this.activity.logActivity({
              tx,
              actorUserId,
              subjectType: 'grant',
              subjectId: c.id,
              verb: 'grant.deleted',
              payload: { grantId: c.id, roleId: before.roleId, ...grantShape(before) },
            });
            continue;
          }
          const cand = candidates[i++];
          const res = await tx.grant.updateMany({
            where: { id: c.id, version: c.version },
            data: {
              effect: cand.effect as GrantEffect,
              scopeKind: cand.scopeKind as ScopeKind,
              scopeDivisionId: cand.scopeDivisionId,
              scopeTeamId: cand.scopeTeamId,
              scopeRoleId: cand.scopeRoleId,
              version: { increment: 1 },
            },
          });
          if (res.count !== 1) {
            throw new ConflictError('STALE_GRANT', 'Someone else changed these permissions. Reload to see their changes.');
          }
          await this.activity.logActivity({
            tx,
            actorUserId,
            subjectType: 'grant',
            subjectId: c.id,
            verb: 'grant.updated',
            payload: {
              grantId: c.id,
              roleId: before.roleId,
              before: grantShape(before),
              after: grantShape({ ...before, ...cand, effect: cand.effect as GrantEffect, scopeKind: cand.scopeKind as ScopeKind }),
            },
          });
        }
        await this.access.bumpConfigVersion(tx);
      },
    );
    return this.list();
  }
}

/** A grant's configuration, as audited (action, effect, scope). */
function grantShape(g: {
  action: string;
  effect: GrantEffect;
  scopeKind: ScopeKind | string;
  scopeDivisionId?: string | null;
  scopeTeamId?: string | null;
  scopeRoleId?: string | null;
}) {
  return {
    action: g.action,
    effect: g.effect,
    scopeKind: g.scopeKind,
    scopeId: g.scopeDivisionId ?? g.scopeTeamId ?? g.scopeRoleId ?? null,
  };
}

const BATCH_ACTION = {
  create: ACTIONS.grantCreate.action,
  update: ACTIONS.grantUpdate.action,
  delete: ACTIONS.grantDelete.action,
} as const;
