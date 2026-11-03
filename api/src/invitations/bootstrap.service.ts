import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { GrantEffect, RoleKind, ScopeKind } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AdministrabilityService } from '../access/administrability.service';
import { ADMIN_SEED_ACTIONS } from '../access/actions';
import { generateInviteToken, generateOpaqueToken, hashToken } from '../common/tokens';
import { PROCESS_ROLE, isApiRole, type ProcessRoleValue } from '../common/process-role';

const ADMIN_ROLE_NAME = 'Admin';
const BOOTSTRAP_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000; // long-lived; gated by passcode

export interface BootstrapStatus {
  open: boolean;
  /** The system invite token to redeem (still requires the passcode). */
  inviteToken: string | null;
}

/**
 * Boot-time seeding + bootstrap mode.
 *
 * On boot: ensure the settings row, the seeded **Admin** role, and its global
 * grants exist (idempotent). Then, if there is **no effective admin**, mint a
 * fresh ephemeral **bootstrap key** (printed to stdout, never persisted) and ensure
 * a single passcode-gated system invitation. A restart while unbootstrapped rotates
 * the key (old key dead). When an effective admin exists, bootstrap mode is closed
 * (any lingering system invite is revoked).
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);
  /** Plaintext token of the live system invite, cached for status responses. */
  private liveInviteToken: string | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly admin: AdministrabilityService,
    private readonly settings: SettingsService,
    @Inject(PROCESS_ROLE) private readonly processRole: ProcessRoleValue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!isApiRole(this.processRole)) return;
    await this.ensureSeed();
    await this.refreshBootstrap();
  }

  /** Ensure the settings row, the Admin role and its grants exist. */
  private async ensureSeed(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.settings.ensureRow(tx);

      let adminRole = await tx.role.findFirst({
        where: { kind: RoleKind.standalone, name: ADMIN_ROLE_NAME },
        select: { id: true },
      });
      if (!adminRole) {
        adminRole = await tx.role.create({
          data: { name: ADMIN_ROLE_NAME, kind: RoleKind.standalone },
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
    });
  }

  /** Mint/rotate or close the bootstrap system invite based on effective-admin presence. */
  private async refreshBootstrap(): Promise<void> {
    const hasAdmin = await this.admin.effectiveAdminExists();
    if (hasAdmin) {
      await this.closeBootstrap();
      this.liveInviteToken = null;
      this.logger.log('Effective admin present — bootstrap mode closed.');
      return;
    }

    const adminRole = await this.prisma.role.findFirstOrThrow({
      where: { kind: RoleKind.standalone, name: ADMIN_ROLE_NAME },
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
      // Rotate the passcode (old key dead); reuse the token.
      const token = generateInviteToken();
      await this.prisma.invitation.update({
        where: { id: existing.id },
        data: {
          passcodeHash,
          tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
          expiresAt,
        },
      });
      this.liveInviteToken = token;
    } else {
      const token = generateInviteToken();
      await this.prisma.invitation.create({
        data: {
          tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
          intendedRoleIds: [adminRole.id],
          passcodeHash,
          maxUses: 1,
          createdBy: null,
          expiresAt,
        },
      });
      this.liveInviteToken = token;
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
    return {
      open: !hasAdmin,
      inviteToken: hasAdmin ? null : this.liveInviteToken,
    };
  }
}
