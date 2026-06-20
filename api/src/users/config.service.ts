import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { ActivityService } from '../activity/activity.service';
import { UpdateConfigDto } from './users.dto';

/** Org-settings v1 defaults (docs/slices/02 "Organization settings"). */
export const SETTINGS_DEFAULTS = {
  requireVerifiedEmailToLogIn: false,
  selfReviewAllowed: false,
  anonymizeLabel: false,
  sessionAbsoluteDays: 30,
  sessionIdleDays: 7,
} as const;

export type OrgSettings = {
  requireVerifiedEmailToLogIn: boolean;
  selfReviewAllowed: boolean;
  anonymizeLabel: boolean;
  sessionAbsoluteDays: number;
  sessionIdleDays: number;
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
  ) {}

  async get(organizationId: string): Promise<OrgSettings> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    return { ...SETTINGS_DEFAULTS, ...(org.settings as Partial<OrgSettings>) };
  }

  async update(
    organizationId: string,
    actorUserId: string,
    dto: UpdateConfigDto,
  ): Promise<OrgSettings> {
    const current = await this.get(organizationId);
    const next: OrgSettings = { ...current, ...dto };
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
    return next;
  }
}
