import { Injectable } from '@nestjs/common';
import { Prisma, SystemSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** The one `system_settings` row (CHECK id = 1 in the migration). */
export const SETTINGS_ROW_ID = 1;

/**
 * Activity subject for system-wide events (settings changes, GC sweeps). The settings
 * row has an integer key and `activity.subject_id` is a UUID, so they use this fixed id.
 */
export const SYSTEM_SUBJECT_ID = '00000000-0000-0000-0000-000000000001';

/** The typed settings a caller may read (row metadata stripped). */
export type Settings = Omit<SystemSettings, 'id' | 'createdAt' | 'updatedAt' | 'configVersion'>;

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Typed org-wide settings. Every reader goes through here rather than touching the
 * row directly, so the row's existence and defaults are guaranteed in one place.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create the row if missing (boot and test reset). Idempotent. */
  async ensureRow(db: Db = this.prisma): Promise<void> {
    await db.systemSettings.upsert({
      where: { id: SETTINGS_ROW_ID },
      create: { id: SETTINGS_ROW_ID },
      update: {},
    });
  }

  async get(db: Db = this.prisma): Promise<Settings> {
    const { id: _id, createdAt: _c, updatedAt: _u, configVersion: _v, ...settings } =
      await db.systemSettings.findUniqueOrThrow({ where: { id: SETTINGS_ROW_ID } });
    return settings;
  }

  async update(data: Partial<Settings>, db: Db = this.prisma): Promise<void> {
    await db.systemSettings.update({ where: { id: SETTINGS_ROW_ID }, data });
  }

  /** The Cedar projection cache key. Read fresh on every decision; never cached. */
  async configVersion(db: Db = this.prisma): Promise<bigint> {
    const row = await db.systemSettings.findUniqueOrThrow({
      where: { id: SETTINGS_ROW_ID },
      select: { configVersion: true },
    });
    return row.configVersion;
  }

  async bumpConfigVersion(db: Db = this.prisma): Promise<void> {
    await db.systemSettings.update({
      where: { id: SETTINGS_ROW_ID },
      data: { configVersion: { increment: 1 } },
    });
  }

  /** The retire → revive grace window, in milliseconds. */
  async graceWindowMs(db: Db = this.prisma): Promise<number> {
    const { gracePeriodHours } = await this.get(db);
    return gracePeriodHours * 60 * 60 * 1000;
  }
}
