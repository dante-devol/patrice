import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ALL_ACTION_STRINGS, CedarEntityType } from './actions';
import { CedarEngine, CedarEntity, CedarUid } from './cedar/engine';
import {
  ProjectableGrant,
  grantToPolicy,
  staticPolicies,
} from './cedar/policies';

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

interface ProjectedSet {
  configVersion: bigint;
  policiesText: string;
}

/**
 * The single access-evaluation engine (docs/ARCHITECTURE.md §2.3). Projects grant
 * rows + static policies into a Cedar policy set cached by `system_settings.config_version`,
 * resolves the principal per request, and returns the Cedar decision.
 *
 * `config_version` is read **fresh from the DB per request** — it is the cache key,
 * and the key is never itself cached (multi-instance correctness seam). The inputs
 * it keys (the projected policy text) are cached.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);
  private cache: ProjectedSet | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cedar: CedarEngine,
    private readonly settings: SettingsService,
  ) {}

  /** Build (or reuse cached) projected policy text for the given config version. */
  private async getPolicies(configVersion: bigint): Promise<string> {
    if (this.cache && this.cache.configVersion === configVersion) {
      return this.cache.policiesText;
    }
    const policiesText = await this.projectPolicies();
    this.cache = { configVersion, policiesText };
    return policiesText;
  }

  /** Project all active grants + static policies into one Cedar policy-set text. */
  async projectPolicies(): Promise<string> {
    const { selfReviewAllowed } = await this.settings.get();

    const grants = await this.prisma.grant.findMany({
      where: {
        lifecycleState: 'active',
        role: { lifecycleState: 'active' },
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

    const grantPolicies = grants.map((g) =>
      grantToPolicy(g as ProjectableGrant),
    );
    const statics = staticPolicies({
      selfReviewAllowed,
      registeredActions: ALL_ACTION_STRINGS,
    });

    const policiesText = [...statics, ...grantPolicies].join('\n\n');

    const errors = this.cedar.parseErrors(policiesText);
    if (errors.length > 0) {
      // Refuse to activate an unparseable policy set — a projection bug must not
      // silently produce a deny-all (or worse) engine state.
      throw new Error(`Projected Cedar policy set failed to parse: ${errors.join('; ')}`);
    }
    return policiesText;
  }

  /** Force the next decide() to re-project (call after any grant/role/settings change). */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Bump `system_settings.config_version` (the cache generation) and drop the
   * local projection cache. Call inside the same transaction as any role/grant/
   * membership/settings change so a reader on the next request re-projects.
   */
  async bumpConfigVersion(
    tx?: PrismaService | import('@prisma/client').Prisma.TransactionClient,
  ): Promise<void> {
    await this.settings.bumpConfigVersion(tx ?? this.prisma);
    this.invalidate();
  }

  /**
   * Resolve the principal User entity + the Role group entities it belongs to.
   * The principal carries `memberDivisions`/`memberTeams` derived from the
   * division/team inherent roles it holds (empty in Slice 1 — standalone roles).
   */
  private async buildPrincipalEntities(
    userId: string,
  ): Promise<{ principal: CedarUid; entities: CedarEntity[] }> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, role: { lifecycleState: 'active' } },
      select: { role: { select: { id: true, divisionId: true, teamId: true } } },
    });

    const roleUids: CedarUid[] = userRoles.map((ur) => ({
      type: CedarEngine.qualify('Role'),
      id: ur.role.id,
    }));
    const memberDivisions = userRoles
      .filter((ur) => ur.role.divisionId)
      .map((ur) => ({ type: CedarEngine.qualify('Division'), id: ur.role.divisionId! }));
    const memberTeams = userRoles
      .filter((ur) => ur.role.teamId)
      .map((ur) => ({ type: CedarEngine.qualify('Team'), id: ur.role.teamId! }));

    const principal: CedarUid = { type: CedarEngine.qualify('User'), id: userId };

    const entities: CedarEntity[] = [
      {
        uid: principal,
        attrs: {
          memberDivisions: memberDivisions.map((d) => ({ __entity: d })),
          memberTeams: memberTeams.map((t) => ({ __entity: t })),
        },
        parents: roleUids,
      },
      // Role group entities (referenced by `principal in Role::"..."`).
      ...roleUids.map((uid) => ({ uid, attrs: {}, parents: [] })),
    ];
    return { principal, entities };
  }

  /** Merge entities sharing a UID (last-write-wins on attrs; union of parents). */
  private dedupeEntities(list: CedarEntity[]): CedarEntity[] {
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
      for (const p of e.parents) {
        if (!seen.has(`${p.type}::${p.id}`)) prior.parents.push(p);
      }
    }
    return [...byKey.values()];
  }

  /** Evaluate one authorization request. Returns true iff Cedar decides `allow`. */
  async decide(args: DecideArgs): Promise<boolean> {
    const policiesText = await this.getPolicies(await this.settings.configVersion());
    const { principal, entities } = await this.buildPrincipalEntities(args.userId);

    const resourceUid: CedarUid = {
      type: CedarEngine.qualify(args.resource.type),
      id: args.resource.id,
    };
    const resourceEntity: CedarEntity = {
      uid: resourceUid,
      attrs: args.resource.attrs ?? {},
      parents: [],
    };

    // A self-targeting request (e.g. an admin revoking their own role) makes the
    // resource UID collide with the principal UID. Cedar rejects duplicate entity
    // entries, so merge same-UID entities — the principal's role membership and the
    // resource's own attributes (targetRole/retired) must both be present.
    const merged = this.dedupeEntities([...entities, resourceEntity]);

    return this.cedar.authorize({
      principal,
      action: { type: CedarEngine.actionType(), id: args.action },
      resource: resourceUid,
      context: args.context,
      entities: merged,
      policiesText,
    });
  }
}
