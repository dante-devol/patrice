import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
 * rows + static policies into a Cedar policy set cached by `organization.config_version`,
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
  ) {}

  /** Read the singleton org's id + current config_version (one indexed PK read). */
  private async readOrg(): Promise<{ id: string; configVersion: bigint }> {
    const org = await this.prisma.organization.findFirstOrThrow({
      select: { id: true, configVersion: true },
    });
    return { id: org.id, configVersion: org.configVersion };
  }

  /** Build (or reuse cached) projected policy text for the given config version. */
  private async getPolicies(
    orgId: string,
    configVersion: bigint,
  ): Promise<string> {
    if (this.cache && this.cache.configVersion === configVersion) {
      return this.cache.policiesText;
    }
    const policiesText = await this.projectPolicies(orgId);
    this.cache = { configVersion, policiesText };
    return policiesText;
  }

  /** Project all active grants + static policies into one Cedar policy-set text. */
  async projectPolicies(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { settings: true },
    });
    const settings = (org.settings ?? {}) as Record<string, unknown>;
    const selfReviewAllowed = settings.selfReviewAllowed === true;

    const grants = await this.prisma.grant.findMany({
      where: {
        organizationId: orgId,
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
   * Bump `organization.config_version` (org-wide cache generation) and drop the
   * local projection cache. Call inside the same transaction as any role/grant/
   * membership/settings change so a reader on the next request re-projects.
   */
  async bumpConfigVersion(
    organizationId: string,
    tx?: PrismaService | import('@prisma/client').Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    await db.organization.update({
      where: { id: organizationId },
      data: { configVersion: { increment: 1 } },
    });
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
    const org = await this.readOrg();
    const policiesText = await this.getPolicies(org.id, org.configVersion);
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
