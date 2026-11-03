import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

/**
 * Resolves the **Grace Period** (api/CONTEXT.md) from `system_settings.grace_period_hours`.
 * The window governs both Revive (allowed while inside it) and GC (skips while inside
 * it), so a single source keeps the two consistent. Returned in milliseconds for
 * direct comparison against `now() - retired_at` ({@link isRevivable}).
 */
@Injectable()
export class GraceService {
  constructor(private readonly settings: SettingsService) {}

  /** The grace window in milliseconds. */
  async windowMs(): Promise<number> {
    return this.settings.graceWindowMs();
  }
}
