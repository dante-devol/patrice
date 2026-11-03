import { Inject, Injectable } from '@nestjs/common';
import { AuthProvider, Prisma } from '@prisma/client';
import { ENV, Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { CedarEngine } from '../access/cedar/engine';
import { ActivityService } from '../activity/activity.service';
import { PasswordService } from '../auth/password';
import { VerificationService } from '../auth/verification.service';
import {
  generateInviteToken,
  hashToken,
  safeEqualHex,
} from '../common/tokens';
import {
  ConflictError,
  DeniedError,
  GoneError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { deriveInvitationStatus, InvitationStatus } from './invitation-status';

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InviteView {
  // Whether the invite is bound to a specific email. The bound *value* is never
  // exposed — the redeemer must already know it (knowledge factor against link
  // leakage), and the server enforces the match on accept.
  requiresEmail: boolean;
  requiresPasscode: boolean;
  status: InvitationStatus;
  isBootstrap: boolean;
}

export interface InviteListItem {
  id: string;
  email: string | null;
  intendedRoleIds: string[];
  maxUses: number;
  useCount: number;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
}

export interface AcceptResult {
  userId: string;
  isBootstrap: boolean;
}

/** How the redeeming user's first `user_identity` (sign-in method) is created. */
type IdentitySpec =
  | { provider: typeof AuthProvider.password; passwordHash: string }
  | { provider: Exclude<AuthProvider, 'password'>; providerSubject: string };

/**
 * Invitations are the **only** account-creation path (no open sign-up). A bootstrap
 * invitation is the same model with `created_by = NULL` + a passcode; redeeming it
 * auto-verifies the first identity and closes bootstrap mode.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly passwords: PasswordService,
    private readonly verification: VerificationService,
    private readonly settings: SettingsService,
  ) {}

  /** Peppered, like every other stored secret (see BootstrapService). */
  private passcodeHash(passcode: string): string {
    return hashToken(this.env.TOKEN_PEPPER, passcode);
  }

  /**
   * Privilege bound (ARCHITECTURE.md §2.13): an invite's pre-assigned roles must be a
   * subset of what the actor may grant (`user:grant_role` scope). Enforced at creation
   * AND re-validated at redemption against the issuer's *current* scope, so a leaked or
   * pre-minted invite can never confer a role the issuer couldn't grant directly (the
   * direct path checks the same thing in users.service `reauthorizeRoleScope`). Bootstrap
   * invites (`created_by = null`) bypass this — their Admin grant is system-authored.
   */
  private async assertRolesGrantable(
    actorUserId: string,
    roleIds: string[],
  ): Promise<void> {
    for (const roleId of roleIds) {
      const allowed = await this.access.decide({
        userId: actorUserId,
        action: ACTIONS.userGrantRole.action,
        resource: {
          // No target user exists yet at invite time; grant_role's scope keys off the
          // role being granted (role-scope) or is global, not the invitee identity.
          type: 'User',
          id: 'prospective-invitee',
          attrs: {
            targetRole: {
              __entity: { type: CedarEngine.qualify('Role'), id: roleId },
            },
          },
        },
      });
      if (!allowed) {
        throw new DeniedError(
          'ROLE_NOT_GRANTABLE',
          'Invitation includes a role you are not permitted to grant',
        );
      }
    }
  }

  /** The Member role, if it still exists and the creator may grant it. */
  private async defaultRoles(creatorUserId: string): Promise<string[]> {
    const { memberRoleId } = await this.settings.get();
    if (!memberRoleId) return [];
    try {
      await this.assertRolesGrantable(creatorUserId, [memberRoleId]);
      return [memberRoleId];
    } catch {
      return [];
    }
  }

  /** Create a normal (non-bootstrap) invitation. Returns the plaintext token. */
  async create(args: {
    creatorUserId: string;
    email?: string | null;
    intendedRoleIds?: string[];
    expiresAt?: Date;
  }): Promise<{ id: string; token: string }> {
    // Omitted roles default to the seeded Member role, when the creator may grant it.
    const intendedRoleIds = args.intendedRoleIds ?? (await this.defaultRoles(args.creatorUserId));
    // Privilege bound at creation — the creator may only pre-assign roles they could
    // grant directly (re-validated again at redemption below).
    await this.assertRolesGrantable(args.creatorUserId, intendedRoleIds);

    const token = generateInviteToken();
    const invitation = await this.prisma.invitation.create({
      data: {
        tokenHash: hashToken(this.env.TOKEN_PEPPER, token),
        email: args.email ?? null,
        roles: { create: intendedRoleIds.map((roleId) => ({ roleId })) },
        maxUses: 1,
        createdBy: args.creatorUserId,
        expiresAt: args.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS),
      },
      select: { id: true },
    });
    await this.activity.logActivity({
      actorUserId: args.creatorUserId,
      subjectType: 'invitation',
      subjectId: invitation.id,
      verb: 'invite.created',
      payload: {
        invitationId: invitation.id,
        intendedRoleIds,
        isBootstrap: false,
      },
    });
    return { id: invitation.id, token };
  }

  /** Read-only invite metadata; never consumes (GET /invite/:token). */
  async view(token: string): Promise<InviteView> {
    const inv = await this.findByToken(token);
    if (!inv) throw new NotFoundError('INVITE_NOT_FOUND', 'Invitation not found');
    return {
      requiresEmail: inv.email != null,
      requiresPasscode: inv.passcodeHash != null,
      status: deriveInvitationStatus(inv),
      isBootstrap: inv.createdBy == null,
    };
  }

  /** List invitations for the org with derived status (admin, invite:create gated). */
  async list(): Promise<InviteListItem[]> {
    const rows = await this.prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      include: { roles: { select: { roleId: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      intendedRoleIds: r.roles.map((x) => x.roleId),
      maxUses: r.maxUses,
      useCount: r.useCount,
      status: deriveInvitationStatus(r),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Revoke an invitation (invite:retire). */
  async revoke(invitationId: string, actorUserId: string): Promise<void> {
    const inv = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { id: true, revokedAt: true },
    });
    if (!inv) throw new NotFoundError('INVITE_NOT_FOUND', 'Invitation not found');
    if (inv.revokedAt) return;
    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { revokedAt: new Date() },
    });
    await this.activity.logActivity({
      actorUserId,
      subjectType: 'invitation',
      subjectId: inv.id,
      verb: 'invite.revoked',
      payload: { invitationId: inv.id },
    });
  }

  private async findByToken(token: string) {
    return this.findByTokenHash(hashToken(this.env.TOKEN_PEPPER, token));
  }

  /** The invitation with its pre-assigned role ids flattened onto it. */
  private async findByTokenHash(tokenHash: string) {
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash },
      include: { roles: { select: { roleId: true } } },
    });
    return inv ? { ...inv, intendedRoleIds: inv.roles.map((r) => r.roleId) } : null;
  }

  /**
   * Redeem an invitation with email + password (the email/password registration
   * path). Delegates to {@link redeem} with a password identity.
   */
  async accept(args: {
    token: string;
    passcode?: string;
    email: string;
    password: string;
    displayName: string;
  }): Promise<AcceptResult> {
    const passwordHash = await this.passwords.hash(args.password);
    return this.redeem({
      tokenHash: hashToken(this.env.TOKEN_PEPPER, args.token),
      passcode: args.passcode,
      email: args.email,
      displayName: args.displayName,
      identity: { provider: AuthProvider.password, passwordHash },
    });
  }

  /**
   * Redeem an invitation with Discord as the sign-in method ("Continue with
   * Discord" on the accept page). The resulting `user_identity[discord]` is the
   * auth record; the integration link (`external_identity`) is a *separate*,
   * user-driven concern handled after login (Phase 2). Consumption still happens
   * on the OAuth callback, which requires a valid one-time Discord `code` — so the
   * POST-only redemption protection against link-scanners (§2.13) is preserved
   * even though the callback is a GET (a scanner can't forge the code).
   *
   * `email` may be null (the user declined the `email` scope); it is captured only
   * as a contact attribute, never the join key.
   */
  async acceptWithProvider(args: {
    /** The invite token's hash; the plaintext never travels through the provider. */
    inviteTokenHash: string;
    provider: Exclude<AuthProvider, 'password'>;
    email: string | null;
    displayName: string;
    providerSubject: string;
  }): Promise<AcceptResult> {
    return this.redeem({
      tokenHash: args.inviteTokenHash,
      email: args.email,
      displayName: args.displayName,
      identity: { provider: args.provider, providerSubject: args.providerSubject },
    });
  }

  /**
   * The shared redemption core: atomic FCFS consumption, then user/identity
   * creation, role grants, and (for bootstrap) auto-verification + config bump.
   * OAuth identities (Discord/Google) are verified-on-create and never trigger a
   * verification email; password identities verify via the email-token flow.
   */
  private async redeem(args: {
    tokenHash: string;
    passcode?: string;
    email: string | null;
    displayName: string;
    identity: IdentitySpec;
  }): Promise<AcceptResult> {
    const inv = await this.findByTokenHash(args.tokenHash);
    if (!inv) throw new NotFoundError('INVITE_NOT_FOUND', 'Invitation not found');

    const status = deriveInvitationStatus(inv);
    if (status !== 'pending') {
      throw new GoneError('INVITE_UNAVAILABLE', `Invitation is ${status}`);
    }

    const isBootstrap = inv.createdBy == null;
    if (inv.passcodeHash) {
      const provided = args.passcode ? this.passcodeHash(args.passcode) : '';
      if (!provided || !safeEqualHex(provided, inv.passcodeHash)) {
        throw new DeniedError('INVALID_PASSCODE', 'Invalid bootstrap passcode');
      }
    }

    // Email gate: an invite bound to a specific email may only be redeemed with
    // that email. The bound value is never exposed by the API, so the redeemer must
    // already know it — this is the knowledge factor that makes email-gating
    // meaningful against a leaked invite link. A Discord login that shares no email
    // (or a mismatched one) cannot satisfy an email-bound invite — the user must
    // register with that email instead.
    if (inv.email && args.email?.toLowerCase() !== inv.email.toLowerCase()) {
      throw new DeniedError(
        'EMAIL_MISMATCH',
        'This invitation was issued to a different email address',
      );
    }

    // Re-validate the privilege bound at redemption against the issuer's *current*
    // grantable scope — a since-shrunk creator scope cannot leak privilege through a
    // pre-minted invite (§2.13). Bootstrap invites (created_by = null) are exempt.
    if (!isBootstrap && inv.intendedRoleIds.length > 0) {
      await this.assertRolesGrantable(inv.createdBy!, inv.intendedRoleIds);
    }

    // One provider account maps to one Patrice user ((provider, subject) unique).
    // Pre-check for a friendly error before the DB constraint fires.
    if (args.identity.provider !== AuthProvider.password) {
      const linked = await this.prisma.userIdentity.findUnique({
        where: {
          provider_providerSubject: {
            provider: args.identity.provider,
            providerSubject: args.identity.providerSubject,
          },
        },
        select: { id: true },
      });
      if (linked) {
        throw new ConflictError(
          'DISCORD_ALREADY_LINKED',
          'This Discord account is already linked to a Patrice account',
        );
      }
    }

    // Friendly, field-targeted message for the common duplicate-email case (the DB
    // unique index is still the authoritative backstop for the concurrent race).
    // Skipped when no email is supplied (a Discord login without the email scope).
    if (args.email) {
      const existingEmail = await this.prisma.appUser.findFirst({
        where: { email: args.email },
        select: { id: true },
      });
      if (existingEmail) {
        throw new ValidationError('An account with this email address already exists', [
          { field: 'email', message: 'An account with this email address already exists' },
        ]);
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Atomic FCFS: exactly one concurrent accept wins the use.
      const consumed = await tx.$executeRaw`
        UPDATE invitation SET use_count = use_count + 1
        WHERE id = ${inv.id}::uuid
          AND use_count < max_uses
          AND revoked_at IS NULL
          AND now() < expires_at
      `;
      if (consumed === 0) {
        throw new ConflictError('INVITE_RACE_LOST', 'Invitation was just consumed');
      }

      const user = await tx.appUser.create({
        data: {
          email: args.email,
          displayName: args.displayName,
          createdViaInvitationId: inv.id,
        },
        select: { id: true },
      });

      await tx.userIdentity.create({
        data: {
          userId: user.id,
          provider: args.identity.provider,
          passwordHash:
            args.identity.provider === AuthProvider.password
              ? args.identity.passwordHash
              : null,
          providerSubject:
            args.identity.provider === AuthProvider.discord
              ? args.identity.providerSubject
              : null,
          // OAuth identities prove control of the account at consent time, so they
          // start verified. Password identities verify via email — except bootstrap,
          // which auto-verifies (brick-on-SMTP risk for the first user outranks it).
          verifiedAt:
            args.identity.provider !== AuthProvider.password || isBootstrap
              ? new Date()
              : null,
        },
      });

      await tx.invitationUse.create({
        data: { invitationId: inv.id, createdUserId: user.id },
      });

      // Grant the pre-assigned roles (⊆ creator's grantable set; trivially so in
      // Slice 1). Bootstrap grants the Admin role.
      for (const roleId of inv.intendedRoleIds) {
        await tx.userRole.create({
          data: { userId: user.id, roleId, grantedBy: inv.createdBy },
        });
      }

      // A membership/role change is a config change — bump the org-wide version so
      // the engine re-projects (the new user's roles take effect immediately).
      await this.access.bumpConfigVersion(tx);

      await this.writeAcceptActivity(tx, {
        userId: user.id,
        invitationId: inv.id,
        grantedRoleIds: inv.intendedRoleIds,
        isBootstrap,
        identityProvider: args.identity.provider,
      });

      return { userId: user.id };
    });

    // Drop the stale projection cache now that grants/membership changed.
    this.access.invalidate();

    if (!isBootstrap && args.identity.provider === AuthProvider.password && args.email) {
      // Send a verification email for normal password registrations (best-effort).
      await this.verification
        .issueVerification(result.userId)
        .catch(() => undefined);
    }

    return { userId: result.userId, isBootstrap };
  }

  private async writeAcceptActivity(
    tx: Prisma.TransactionClient,
    args: {
      userId: string;
      invitationId: string;
      grantedRoleIds: string[];
      isBootstrap: boolean;
      identityProvider: AuthProvider;
    },
  ): Promise<void> {
    await this.activity.logActivity({
      tx,
      actorUserId: args.userId,
      subjectType: 'user',
      subjectId: args.userId,
      verb: 'user.registered',
      payload: {
        userId: args.userId,
        invitationId: args.invitationId,
        identityProvider: args.identityProvider,
      },
    });
    await this.activity.logActivity({
      tx,
      actorUserId: args.userId,
      subjectType: 'invitation',
      subjectId: args.invitationId,
      verb: 'invite.redeemed',
      payload: {
        invitationId: args.invitationId,
        createdUserId: args.userId,
        grantedRoleIds: args.grantedRoleIds,
      },
    });
    if (args.isBootstrap) {
      await this.activity.logActivity({
        tx,
        actorUserId: args.userId,
        subjectType: 'user',
        subjectId: args.userId,
        verb: 'bootstrap.completed',
        payload: { adminUserId: args.userId, invitationId: args.invitationId },
      });
    }
  }
}
