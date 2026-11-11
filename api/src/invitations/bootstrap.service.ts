import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { GrantEffect, LifecycleState, Prisma, RoleKind, ScopeKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AdministrabilityService } from '../access/administrability.service';
import {
  ADMIN_SEED_ACTIONS,
  EVERYONE_SEED_GRANTS,
  MEMBER_UNIT_SEED_GRANTS,
  PROJECT_LEAD_SEED_ACTIONS,
  SeedGrant,
  UNIT_ROLE_ACTIONS,
} from '../access/actions';
import { supportsOwnScope } from '../access/cedar/policies';
import { createHmac } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { generateOpaqueToken, hashToken } from '../common/tokens';

const ADMIN_ROLE_NAME = 'Admin';
const MEMBER_ROLE_NAME = 'Member';
const EVERYONE_ROLE_NAME = 'Everyone';
/** What the org-wide Member becomes when an upgrade retires it (ADR 0022). */
const OLD_MEMBER_ROLE_NAME = 'Member (before unit roles)';
/** Org-wide reads the old Member held, which Everyone now covers. */
const EVERYONE_READS = new Set(EVERYONE_SEED_GRANTS.map((g) => `${g.action}|${g.scopeKind}`));
const PROJECT_LEAD_ROLE_NAME = 'Project lead';
const BOOTSTRAP_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000; // long-lived; gated by passcode

export interface BootstrapStatus {
  open: boolean;
  /** The system invite token to redeem (still requires the passcode). */
  inviteToken: string | null;
}

/**
 * Boot-time seeding and bootstrap mode.
 *
 * Every process ensures the settings row and the seeded roles on boot (idempotent,
 * serialised by an advisory lock, so replicas can start together).
 *
 * Only the **worker** runs bootstrap mode ({@link openBootstrap}, called by the
 * BootstrapWorker): with no effective admin it mints an ephemeral **bootstrap key**
 * (printed to stdout, never persisted) as the passcode of a single system invitation;
 * a worker restart rotates it. Starting more API replicas no longer rotates the key
 * out from under the operator (problems D18). With an effective admin, bootstrap
 * mode is closed.
 *
 * The invitation's token isn't secret (the passcode is), so any process derives it
 * from the invitation's id for the setup page.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly admin: AdministrabilityService,
    private readonly settings: SettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSeed();
  }

  /**
   * Ensure the settings row and the seeded roles exist. Admin holds every action at
   * global scope, topped up whenever an upgrade adds actions. Everyone and the Member
   * unit role are seeded once (ADR 0022) and are then the admins' to edit.
   */
  private async ensureSeed(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('patrice.seed'))`;
      await this.settings.ensureRow(tx);

      let adminRole = await tx.role.findFirst({
        where: { name: ADMIN_ROLE_NAME },
        select: { id: true },
      });
      if (!adminRole) {
        adminRole = await tx.role.create({
          data: { name: ADMIN_ROLE_NAME },
          select: { id: true },
        });
      }

      const existing = await tx.grant.findMany({
        where: { roleId: adminRole.id, scopeKind: ScopeKind.global },
        select: { action: true },
      });
      const have = new Set(existing.map((g) => g.action));
      const missing = ADMIN_SEED_ACTIONS.filter((a) => !have.has(a));
      if (missing.length > 0) {
        await tx.grant.createMany({
          data: missing.map((action) => ({
            roleId: adminRole!.id,
            action,
            effect: GrantEffect.permit,
            scopeKind: ScopeKind.global,
          })),
        });
      }

      const settings = await tx.systemSettings.findUniqueOrThrow({ where: { id: 1 } });
      if (!settings.memberUnitSeeded) await this.seedEveryoneAndMember(tx, settings.memberRoleId);
      if (!settings.projectLeadSeeded) {
        // Seeded once, unassigned and kept for admins to appoint; then the admins' to edit.
        const exists = await tx.role.findFirst({
          where: { name: { equals: PROJECT_LEAD_ROLE_NAME, mode: 'insensitive' } },
          select: { id: true },
        });
        if (!exists) {
          const lead = await tx.role.create({
            data: { name: PROJECT_LEAD_ROLE_NAME, kind: RoleKind.unit, assignableByLeads: false },
            select: { id: true },
          });
          await tx.grant.createMany({
            data: PROJECT_LEAD_SEED_ACTIONS.map((action) => ({
              roleId: lead.id,
              action,
              effect: GrantEffect.permit,
              scopeKind: ScopeKind.assigned,
            })),
          });
        }
        await tx.systemSettings.update({ where: { id: 1 }, data: { projectLeadSeeded: true } });
      }
      await tx.systemSettings.update({ where: { id: 1 }, data: { configVersion: { increment: 1 } } });
    });
  }

  /**
   * Seed Everyone and the Member unit role, once (ADR 0022). On an install that had the
   * org-wide Member, its grants are translated rather than replaced: org-wide reads and
   * "involved" task reads move to Everyone; unit actions scoped to divisions, teams or
   * everywhere become `assigned`, and their `own` grants stay `own` (now within the
   * unit). Anything else is logged and left behind. Every division and team then gets
   * Member as its default, every current member is given it, and the old role retires.
   */
  private async seedEveryoneAndMember(tx: Prisma.TransactionClient, legacyId: string | null): Promise<void> {
    const legacy =
      (legacyId
        ? await tx.role.findFirst({ where: { id: legacyId, kind: RoleKind.org }, select: { id: true } })
        : null) ??
      (await tx.role.findFirst({
        where: { name: { equals: MEMBER_ROLE_NAME, mode: 'insensitive' }, kind: RoleKind.org, lifecycleState: 'active' },
        select: { id: true },
      }));

    // Everyone: exactly one, created once.
    const everyone =
      (await tx.role.findFirst({ where: { kind: RoleKind.baseline }, select: { id: true } })) ??
      (await tx.role.create({ data: { name: EVERYONE_ROLE_NAME, kind: RoleKind.baseline }, select: { id: true } }));

    let memberGrants: SeedGrant[] = [...MEMBER_UNIT_SEED_GRANTS];
    if (legacy) {
      const held = await tx.grant.findMany({
        where: { roleId: legacy.id },
        select: { action: true, effect: true, scopeKind: true },
      });
      memberGrants = [];
      for (const g of held) {
        const key = `${g.action}|${g.scopeKind}`;
        if (g.effect === GrantEffect.permit && EVERYONE_READS.has(key)) continue; // Everyone has it
        const unitAction = UNIT_ROLE_ACTIONS.includes(g.action);
        if (unitAction && g.effect === GrantEffect.permit && ['global', 'own_division', 'own_team'].includes(g.scopeKind)) {
          memberGrants.push({ action: g.action, scopeKind: 'assigned' });
        } else if (unitAction && g.effect === GrantEffect.permit && g.scopeKind === 'own' && supportsOwnScope(g.action)) {
          memberGrants.push({ action: g.action, scopeKind: 'own' });
        } else {
          this.logger.warn(`Member upgrade: not carried over: ${g.effect} ${g.action} @ ${g.scopeKind}`);
        }
      }
      // Leave the name free for the unit role, then retire the old one with no holders.
      await tx.role.update({
        where: { id: legacy.id },
        data: { name: OLD_MEMBER_ROLE_NAME, lifecycleState: LifecycleState.retired, retiredAt: new Date(), version: { increment: 1 } },
      });
      await tx.userRole.deleteMany({ where: { roleId: legacy.id } });
      await tx.invitationRole.deleteMany({ where: { roleId: legacy.id } });
    }
    const haveEveryone = new Set(
      (await tx.grant.findMany({ where: { roleId: everyone.id }, select: { action: true, scopeKind: true } })).map(
        (g) => `${g.action}|${g.scopeKind}`,
      ),
    );
    await tx.grant.createMany({
      data: EVERYONE_SEED_GRANTS.filter((g) => !haveEveryone.has(`${g.action}|${g.scopeKind}`)).map((g) => ({
        roleId: everyone.id,
        action: g.action,
        effect: GrantEffect.permit,
        scopeKind: g.scopeKind,
      })),
    });

    const member = await tx.role.create({
      data: { name: MEMBER_ROLE_NAME, kind: RoleKind.unit, assignableByLeads: true },
      select: { id: true },
    });
    const unique = [...new Map(memberGrants.map((g) => [`${g.action}|${g.scopeKind}`, g])).values()];
    await tx.grant.createMany({
      data: unique.map((g) => ({ roleId: member.id, action: g.action, effect: GrantEffect.permit, scopeKind: g.scopeKind })),
    });

    // Every unit's default, and every current member holds it there.
    await tx.division.updateMany({ where: { defaultRoleId: null }, data: { defaultRoleId: member.id } });
    await tx.team.updateMany({ where: { defaultRoleId: null }, data: { defaultRoleId: member.id } });
    const memberships = await tx.membership.findMany({ select: { userId: true, divisionId: true, teamId: true } });
    await tx.unitRoleAssignment.createMany({
      data: memberships.map((m) => ({
        userId: m.userId,
        roleId: member.id,
        divisionId: m.divisionId,
        teamId: m.teamId,
        viaDefault: true,
      })),
    });
    await tx.systemSettings.update({
      where: { id: 1 },
      data: { defaultUnitRoleId: member.id, memberRoleId: null, memberRoleSeeded: true, memberUnitSeeded: true },
    });
  }

  /**
   * Mint or rotate the bootstrap system invite, or close it when an effective admin
   * exists. Worker only; prints the new key.
   */
  async openBootstrap(): Promise<void> {
    await this.ensureSeed();
    const hasAdmin = await this.admin.effectiveAdminExists();
    if (hasAdmin) {
      await this.closeBootstrap();
      this.logger.log('Effective admin present — bootstrap mode closed.');
      return;
    }

    const adminRole = await this.prisma.role.findFirstOrThrow({
      where: { name: ADMIN_ROLE_NAME },
      select: { id: true },
    });

    const key = generateOpaqueToken(24);
    // Peppered like every other stored secret (InvitationsService checks the same way).
    const passcodeHash = hashToken(this.env.TOKEN_PEPPER, key);
    const expiresAt = new Date(Date.now() + BOOTSTRAP_EXPIRY_MS);

    const existing = await this.prisma.invitation.findFirst({
      where: { createdBy: null, revokedAt: null },
      select: { id: true },
    });

    if (existing) {
      // Rotate the passcode; the old key is dead.
      await this.prisma.invitation.update({
        where: { id: existing.id },
        data: { passcodeHash, expiresAt },
      });
    } else {
      const id = uuidv7();
      await this.prisma.invitation.create({
        data: {
          id,
          tokenHash: hashToken(this.env.TOKEN_PEPPER, this.tokenFor(id)),
          roles: { create: [{ roleId: adminRole.id }] },
          passcodeHash,
          maxUses: 1,
          createdBy: null,
          expiresAt,
        },
      });
    }

    this.printKey(key);
  }

  /** Revoke any lingering system invitation. */
  private async closeBootstrap(): Promise<void> {
    await this.prisma.invitation.updateMany({
      where: { createdBy: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private printKey(key: string): void {
    // Printed to stdout only; never persisted. This is the irreducible first-run
    // credential and doubles as lockout recovery.
    // eslint-disable-next-line no-console
    console.log(
      `\n========================================\n` +
        `  PATRICE BOOTSTRAP KEY: ${key}\n` +
        `  No effective admin exists. Visit the setup page and enter this key\n` +
        `  to register the first administrator. This key is ephemeral and dies\n` +
        `  with this process.\n` +
        `========================================\n`,
    );
  }

  /** Public status for the web Setup page. */
  async getStatus(): Promise<BootstrapStatus> {
    const hasAdmin = await this.admin.effectiveAdminExists();
    if (hasAdmin) return { open: false, inviteToken: null };
    const invite = await this.prisma.invitation.findFirst({
      where: { createdBy: null, revokedAt: null },
      select: { id: true },
    });
    return { open: true, inviteToken: invite ? this.tokenFor(invite.id) : null };
  }

  /** The system invitation's token, derived from its id (the passcode is the secret). */
  private tokenFor(invitationId: string): string {
    return createHmac('sha256', this.env.TOKEN_PEPPER).update(`bootstrap-invite:${invitationId}`).digest('base64url');
  }
}
