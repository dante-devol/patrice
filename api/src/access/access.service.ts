import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DeniedError } from '../common/errors';
import { SettingsService } from '../settings/settings.service';
import { ACTIONS, ALL_ACTION_STRINGS, CedarEntityType, TASK_FAMILY_ACTIONS } from './actions';
import { CedarEngine, CedarEntity, CedarUid } from './cedar/engine';
import { ProjectableGrant, UnitPlacement, grantToPolicies, staticPolicies, unitRoleId } from './cedar/policies';

export interface ResourceRef {
  type: CedarEntityType;
  id: string;
  attrs?: Record<string, unknown>;
}

/**
 * The Cedar resource for org-wide (governance and create) actions. Single-org, so
 * this is a fixed entity rather than a database row.
 */
export const ORGANIZATION_RESOURCE: ResourceRef = { type: 'Organization', id: 'patrice' };

export interface DecideArgs {
  userId: string;
  action: string;
  resource: ResourceRef;
  context?: Record<string, unknown>;
}

type Db = PrismaService | Prisma.TransactionClient;

interface Principal {
  uid: CedarUid;
  entities: CedarEntity[];
}

/**
 * The single access-evaluation engine. Projects grant rows plus static policies into
 * a Cedar policy set cached by `system_settings.config_version`, builds the principal
 * from its roles and memberships, and returns Cedar's decision.
 *
 * `config_version` is read fresh per decision; it is the cache key and is never itself
 * cached. Principals are built per call and never cached, so role and membership
 * changes take effect on the next request without a version bump.
 */
@Injectable()
export class AccessService {
  private cache: { configVersion: bigint; policiesText: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cedar: CedarEngine,
    private readonly settings: SettingsService,
  ) {}

  private async getPolicies(): Promise<string> {
    const configVersion = await this.settings.configVersion();
    if (this.cache?.configVersion === configVersion) return this.cache.policiesText;
    const policiesText = await this.projectPolicies();
    this.cache = { configVersion, policiesText };
    return policiesText;
  }

  /**
   * Project all active grants plus static policies into one Cedar policy-set text.
   * Pass a transaction to see its uncommitted state (the admin floor does).
   */
  async projectPolicies(db: Db = this.prisma): Promise<string> {
    const { selfReviewAllowed, requireDiscordLink } = await this.settings.get(db);
    const grants = await db.grant.findMany({
      where: { role: { lifecycleState: 'active' } },
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
    const statics = staticPolicies({
      selfReviewAllowed,
      registeredActions: ALL_ACTION_STRINGS,
      discordGatedActions: requireDiscordLink ? TASK_FAMILY_ACTIONS : [],
    });
    const placements = await this.unitPlacements(db);
    const policiesText = [
      ...statics,
      ...grants.flatMap((g) => grantToPolicies(g as ProjectableGrant, placements.get(g.roleId))),
    ].join('\n\n');
    const errors = this.cedar.parseErrors(policiesText);
    if (errors.length > 0) {
      // A projection bug must not silently produce a deny-all (or worse) engine.
      throw new Error(`Projected Cedar policy set failed to parse: ${errors.join('; ')}`);
    }
    return policiesText;
  }

  /** Every unit where each unit role is assigned to someone. */
  private async unitPlacements(db: Db): Promise<Map<string, UnitPlacement[]>> {
    const rows = await db.unitRoleAssignment.findMany({
      distinct: ['roleId', 'divisionId', 'teamId'],
      select: { roleId: true, divisionId: true, teamId: true },
    });
    const byRole = new Map<string, UnitPlacement[]>();
    for (const r of rows) {
      const list = byRole.get(r.roleId) ?? [];
      list.push(placementOf(r));
      byRole.set(r.roleId, list);
    }
    return byRole;
  }

  /** Force the next decision to re-project (after any grant/role/settings change). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Bump `system_settings.config_version` and drop the local projection cache. Call
   * inside the transaction of any change to grants, roles' lifecycle or settings.
   */
  async bumpConfigVersion(tx?: Db): Promise<void> {
    await this.settings.bumpConfigVersion(tx ?? this.prisma);
    this.invalidate();
  }

  /**
   * The principal: a User in its active roles, carrying the divisions and teams it
   * belongs to and whether the `requireDiscordLink` gate applies to it.
   */
  async buildPrincipal(userId: string, db: Db = this.prisma, policiesText?: string): Promise<Principal> {
    const [userRoles, memberships, unitRoles] = await Promise.all([
      db.userRole.findMany({
        where: { userId, role: { lifecycleState: 'active' } },
        select: { roleId: true },
      }),
      db.membership.findMany({
        where: { userId },
        select: { divisionId: true, teamId: true },
      }),
      db.unitRoleAssignment.findMany({
        where: { userId, role: { lifecycleState: 'active' } },
        select: { roleId: true, divisionId: true, teamId: true },
      }),
    ]);
    // Org roles make the user `in Role`; a unit role only `in UnitRole` at its unit.
    const roleUids: CedarUid[] = [
      ...userRoles.map((ur) => ({ type: CedarEngine.qualify('Role'), id: ur.roleId })),
      ...unitRoles.map((a) => ({ type: CedarEngine.qualify('UnitRole'), id: unitRoleId(a.roleId, placementOf(a)) })),
    ];
    const uid: CedarUid = { type: CedarEngine.qualify('User'), id: userId };
    const attrs: Record<string, unknown> = {
      memberDivisions: memberships
        .filter((m) => m.divisionId)
        .map((m) => ({ __entity: { type: CedarEngine.qualify('Division'), id: m.divisionId! } })),
      memberTeams: memberships
        .filter((m) => m.teamId)
        .map((m) => ({ __entity: { type: CedarEngine.qualify('Team'), id: m.teamId! } })),
    };
    const entities: CedarEntity[] = [
      { uid, attrs, parents: roleUids },
      ...roleUids.map((r) => ({ uid: r, attrs: {}, parents: [] })),
    ];
    if (await this.discordGateApplies(userId, db)) {
      // Exempt when Cedar permits the bypass action (asked without the gate flag set).
      const exempt = this.evaluate(
        policiesText ?? (await this.getPolicies()),
        { uid, entities },
        ACTIONS.taskBypassDiscordGate.action,
        ORGANIZATION_RESOURCE,
      );
      attrs.discordGated = !exempt;
    }
    return { uid, entities };
  }

  /** The gate is on, a Discord connection is active, and the user isn't linked to all. */
  private async discordGateApplies(userId: string, db: Db): Promise<boolean> {
    const { requireDiscordLink } = await this.settings.get(db);
    if (!requireDiscordLink) return false;
    const connections = await db.integrationConnection.findMany({
      where: { provider: 'discord', lifecycleState: 'active' },
      select: { id: true },
    });
    if (connections.length === 0) return false;
    const linked = await db.externalIdentity.count({
      where: { userId, connectionId: { in: connections.map((c) => c.id) } },
    });
    return linked < connections.length;
  }

  /** One Cedar evaluation against an already-built principal. */
  evaluate(
    policiesText: string,
    principal: Principal,
    action: string,
    resource: ResourceRef,
    context?: Record<string, unknown>,
  ): boolean {
    const resourceUid: CedarUid = { type: CedarEngine.qualify(resource.type), id: resource.id };
    return this.cedar.authorize({
      principal: principal.uid,
      action: { type: CedarEngine.actionType(), id: action },
      resource: resourceUid,
      context,
      entities: dedupeEntities([
        ...principal.entities,
        { uid: resourceUid, attrs: resource.attrs ?? {}, parents: [] },
      ]),
      policiesText,
    });
  }

  /** Evaluate one authorization request. True iff Cedar decides `allow`. */
  async decide(args: DecideArgs): Promise<boolean> {
    const policiesText = await this.getPolicies();
    const principal = await this.buildPrincipal(args.userId, this.prisma, policiesText);
    return this.evaluate(policiesText, principal, args.action, args.resource, args.context);
  }

  /**
   * Throw `403 FORBIDDEN` unless Cedar permits it. For checks a service makes itself
   * because the resource comes from a validated body (creating a task in a division).
   */
  async assert(userId: string, action: string, resource: ResourceRef): Promise<void> {
    if (!(await this.decide({ userId, action, resource }))) {
      throw new DeniedError('FORBIDDEN', `Not permitted: ${action}`);
    }
  }

  /** Keep the items the user may `action` (list visibility), decided per item by Cedar. */
  async filterAllowed<T>(
    userId: string,
    action: string,
    items: readonly T[],
    toResource: (item: T) => ResourceRef,
  ): Promise<T[]> {
    const allowed = await this.decideMany(userId, items.map((i) => ({ action, resource: toResource(i) })));
    return items.filter((_, i) => allowed[i]);
  }

  /** Several decisions for one principal, building it once. */
  async decideMany(
    userId: string,
    checks: ReadonlyArray<{ action: string; resource: ResourceRef }>,
  ): Promise<boolean[]> {
    if (checks.length === 0) return [];
    const policiesText = await this.getPolicies();
    const principal = await this.buildPrincipal(userId, this.prisma, policiesText);
    return checks.map((c) => this.evaluate(policiesText, principal, c.action, c.resource));
  }

  /** Which of `actions` the user may perform on `resource` (the `allowedActions` field). */
  async allowedActions(userId: string, resource: ResourceRef, actions: readonly string[]): Promise<string[]> {
    const allowed = await this.decideMany(userId, actions.map((action) => ({ action, resource })));
    return actions.filter((_, i) => allowed[i]);
  }
}

/** Merge entities sharing a UID (later attrs win; parents are unioned). */
function dedupeEntities(list: CedarEntity[]): CedarEntity[] {
  const byKey = new Map<string, CedarEntity>();
  for (const e of list) {
    const key = `${e.uid.type}::${e.uid.id}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { uid: e.uid, attrs: { ...e.attrs }, parents: [...e.parents] });
      continue;
    }
    prior.attrs = { ...prior.attrs, ...e.attrs };
    const seen = new Set(prior.parents.map((p) => `${p.type}::${p.id}`));
    for (const p of e.parents) if (!seen.has(`${p.type}::${p.id}`)) prior.parents.push(p);
  }
  return [...byKey.values()];
}

/** A unit-role assignment row's unit. */
function placementOf(a: { divisionId: string | null; teamId: string | null }): UnitPlacement {
  return a.divisionId ? { unitType: 'division', unitId: a.divisionId } : { unitType: 'team', unitId: a.teamId! };
}
