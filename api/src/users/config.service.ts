import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { ENV, Env } from '../config/env';
import { encryptOAuthSecret } from '../auth/oauth-secret.cipher';
import { UpdateConfigDto } from './users.dto';

/** Org-settings v1 defaults (docs/slices/02 "Organization settings"). */
export const SETTINGS_DEFAULTS = {
  requireVerifiedEmailToLogIn: false,
  selfReviewAllowed: false,
  anonymizeLabel: false,
  sessionAbsoluteDays: 30,
  sessionIdleDays: 7,
  // Retire→revive grace window (Slice 7.2). GC skips, and Revive is allowed, while
  // `retired_at > now() - gracePeriodHours`. Default 24h.
  gracePeriodHours: 24,
  // Slice 8: require users to link a Discord account before accessing tasks.
  requireDiscordLink: false,
} as const;

/**
 * Settings as stored in `organization.settings`. Includes the **encrypted** Discord
 * OAuth client secret handle — never leaves the service; {@link ConfigService.get}
 * returns the redacted {@link OrgSettings} instead (ADR 0006).
 */
export type RawOrgSettings = {
  requireVerifiedEmailToLogIn: boolean;
  selfReviewAllowed: boolean;
  anonymizeLabel: boolean;
  sessionAbsoluteDays: number;
  sessionIdleDays: number;
  gracePeriodHours: number;
  requireDiscordLink: boolean;
  discordClientId?: string;
  /** `oauthsec:` handle — encrypted at rest, never returned by any read. */
  discordClientSecret?: string;
};

/** The public view: the client *id* is shown, the secret is replaced by a boolean. */
export type OrgSettings = {
  requireVerifiedEmailToLogIn: boolean;
  selfReviewAllowed: boolean;
  anonymizeLabel: boolean;
  sessionAbsoluteDays: number;
  sessionIdleDays: number;
  gracePeriodHours: number;
  requireDiscordLink: boolean;
  discordClientId: string | null;
  discordOAuthConfigured: boolean;
};

/**
 * The structured `organization.settings` editor (Slice 2.4). Flipping
 * `selfReviewAllowed` changes the projected static policy set (the conditional
 * self-review forbid) so every config write bumps `config_version` and drops the
 * projection cache. Flipping `requireVerifiedEmailToLogIn` only gates **new**
 * logins — it never invalidates existing sessions.
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Raw stored settings incl. the encrypted secret handle — service-internal only. */
  private async getRaw(organizationId: string): Promise<RawOrgSettings> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    return { ...SETTINGS_DEFAULTS, ...(org.settings as Partial<RawOrgSettings>) };
  }

  async get(organizationId: string): Promise<OrgSettings> {
    const r = await this.getRaw(organizationId);
    return {
      requireVerifiedEmailToLogIn: r.requireVerifiedEmailToLogIn,
      selfReviewAllowed: r.selfReviewAllowed,
      anonymizeLabel: r.anonymizeLabel,
      sessionAbsoluteDays: r.sessionAbsoluteDays,
      sessionIdleDays: r.sessionIdleDays,
      gracePeriodHours: r.gracePeriodHours,
      requireDiscordLink: r.requireDiscordLink,
      discordClientId: r.discordClientId ?? null,
      discordOAuthConfigured: !!r.discordClientSecret,
    };
  }

  async update(
    organizationId: string,
    actorUserId: string,
    dto: UpdateConfigDto,
  ): Promise<OrgSettings> {
    const current = await this.getRaw(organizationId);
    // The secret is handled separately (encrypt / clear); everything else spreads.
    const { discordClientSecret, ...rest } = dto;
    const next: RawOrgSettings = { ...current, ...rest };
    if (discordClientSecret !== undefined) {
      if (discordClientSecret === '') {
        delete next.discordClientSecret; // admin cleared it → disable Discord sign-in
      } else {
        next.discordClientSecret = encryptOAuthSecret(this.env.SESSION_SECRET, discordClientSecret);
      }
    }
    const changedKeys = Object.keys(dto);

    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: { settings: next },
      });
      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'organization',
        subjectId: organizationId,
        verb: 'config.updated',
        payload: { changedKeys },
      });
      // Re-project: a selfReviewAllowed flip changes the static policy set.
      await this.access.bumpConfigVersion(organizationId, tx);
    });
    return this.get(organizationId); // redacted — never echo the secret handle
  }
}
