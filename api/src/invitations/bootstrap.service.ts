import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { GrantEffect, ScopeKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AdministrabilityService } from '../access/administrability.service';
import { ADMIN_SEED_ACTIONS, MEMBER_SEED_GRANTS } from '../access/actions';
import { createHmac } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { generateOpaqueToken, hashToken } from '../common/tokens';

const ADMIN_ROLE_NAME = 'Admin';
const MEMBER_ROLE_NAME = 'Member';
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
   * global scope, topped up whenever an upgrade adds actions. Member is seeded once
   * with its starter grants and is then the admins' to edit (or delete).
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
      if (!settings.memberRoleSeeded) {
        // An upgraded install may already have a role by that name: adopt it rather
        // than create a second one, and top up its starter grants.
        const member =
          (await tx.role.findFirst({
            where: { name: { equals: MEMBER_ROLE_NAME, mode: 'insensitive' }, lifecycleState: 'active' },
            select: { id: true },
          })) ?? (await tx.role.create({ data: { name: MEMBER_ROLE_NAME }, select: { id: true } }));
        const held = await tx.grant.findMany({ where: { roleId: member.id }, select: { action: true, scopeKind: true } });
        const have = new Set(held.map((g) => `${g.action}|${g.scopeKind}`));
        await tx.grant.createMany({
          data: MEMBER_SEED_GRANTS.filter((g) => !have.has(`${g.action}|${g.scopeKind}`)).map((g) => ({
            roleId: member.id,
            action: g.action,
            effect: GrantEffect.permit,
            scopeKind: g.scopeKind,
          })),
        });
        // Before Member existed, reads needed no grant. Everyone already here gets it,
        // so an upgrade doesn't take their tasks out of sight; new users get it from
        // their invitation.
        const users = await tx.appUser.findMany({ where: { lifecycleState: 'active' }, select: { id: true } });
        await tx.userRole.createMany({
          data: users.map((u) => ({ userId: u.id, roleId: member.id })),
          skipDuplicates: true,
        });
        await tx.systemSettings.update({
          where: { id: 1 },
          data: { memberRoleId: member.id, memberRoleSeeded: true },
        });
      }
      await tx.systemSettings.update({ where: { id: 1 }, data: { configVersion: { increment: 1 } } });
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
