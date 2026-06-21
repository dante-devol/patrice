import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SETTINGS_DEFAULTS } from '../users/config.service';

/**
 * Resolves the **Grace Period** (api/CONTEXT.md) for an organization from
 * `organization.settings.gracePeriodHours` (Slice 7.2), defaulting to 24h when unset.
 * The window governs both Revive (allowed while inside it) and GC (skips while inside
 * it), so a single source keeps the two consistent. Returned in milliseconds for
 * direct comparison against `now() - retired_at` ({@link isRevivable}).
 */
@Injectable()
export class GraceService {
  constructor(private readonly prisma: PrismaService) {}

  /** The grace window in milliseconds for the given org. */
  async windowMs(organizationId: string): Promise<number> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    return GraceService.windowMsFromSettings(org?.settings);
  }

  /** Pure resolution from a raw settings blob (no DB) — shared by the GC sweep. */
  static windowMsFromSettings(settings: unknown): number {
    const raw = (settings as Record<string, unknown> | null | undefined)
      ?.gracePeriodHours;
    const hours =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
        ? raw
        : SETTINGS_DEFAULTS.gracePeriodHours;
    return hours * 60 * 60 * 1000;
  }
}
