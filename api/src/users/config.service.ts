import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { SettingsService, SYSTEM_SUBJECT_ID } from '../settings/settings.service';
import { SecretStore } from '../settings/secret-store.service';
import { UpdateConfigDto } from './users.dto';

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
 * The settings editor (Slice 2.4). Flipping `selfReviewAllowed` changes the projected
 * static policy set (the conditional self-review forbid), so every config write bumps
 * `config_version` and drops the projection cache. Flipping
 * `requireVerifiedEmailToLogIn` only gates **new** logins; it never invalidates
 * existing sessions.
 */
@Injectable()
export class ConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
    private readonly secrets: SecretStore,
  ) {}

  async get(): Promise<OrgSettings> {
    const s = await this.settings.get();
    return {
      requireVerifiedEmailToLogIn: s.requireVerifiedEmailToLogIn,
      selfReviewAllowed: s.selfReviewAllowed,
      anonymizeLabel: s.anonymizeLabel,
      sessionAbsoluteDays: s.sessionAbsoluteDays,
      sessionIdleDays: s.sessionIdleDays,
      gracePeriodHours: s.gracePeriodHours,
      requireDiscordLink: s.requireDiscordLink,
      discordClientId: s.discordClientId,
      discordOAuthConfigured: await this.secrets.has('discord_oauth_client_secret'),
    };
  }

  async update(actorUserId: string, dto: UpdateConfigDto): Promise<OrgSettings> {
    // The secret is handled separately (encrypt / clear); everything else is a column.
    const { discordClientSecret, ...rest } = dto;
    const changedKeys = Object.keys(dto);

    await this.prisma.$transaction(async (tx) => {
      await this.settings.update(
        { ...rest, ...(rest.discordClientId === '' ? { discordClientId: null } : {}) },
        tx,
      );
      if (discordClientSecret === '') {
        // Admin cleared it → disable Discord sign-in.
        await this.secrets.clear('discord_oauth_client_secret', tx);
      } else if (discordClientSecret !== undefined) {
        await this.secrets.put('discord_oauth_client_secret', discordClientSecret, tx);
      }
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'system',
        subjectId: SYSTEM_SUBJECT_ID,
        verb: 'config.updated',
        payload: { changedKeys },
      });
      // Re-project: a selfReviewAllowed flip changes the static policy set.
      await this.access.bumpConfigVersion(tx);
    });
    return this.get(); // redacted — never echo the secret handle
  }
}
