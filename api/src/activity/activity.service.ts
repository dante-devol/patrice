import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActivityPayload,
  ActivityVerb,
  activityPayloadSchemas,
} from './activity.types';

export interface LogActivityArgs<V extends ActivityVerb> {
  organizationId: string;
  actorUserId?: string | null;
  subjectType: string;
  subjectId: string;
  verb: V;
  payload: ActivityPayload<V>;
  source?: ActivitySource;
  sourceConnectionId?: string | null;
  /** Optional transaction client so an activity row joins the caller's transaction. */
  tx?: Prisma.TransactionClient;
}

/** Filters for the admin audit read (all optional, AND-composed). */
export interface ListActivityFilters {
  after?: string;
  limit: number;
  verb?: string;
  verbPrefix?: string;
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  source?: ActivitySource;
  from?: Date;
  to?: Date;
}

export interface ActivityItem {
  id: string;
  actorUserId: string | null;
  /** Actor's current display name, joined at read time (null = system-actored). */
  actorName: string | null;
  subjectType: string;
  subjectId: string;
  verb: string;
  payload: unknown;
  source: ActivitySource;
  createdAt: Date;
}

export interface ActivityListResult {
  items: ActivityItem[];
  nextCursor: string | null;
}

/**
 * The org-level immutable audit log. `logActivity` is the **only** sanctioned write
 * path (append-only by convention in v1). Payloads are Zod-validated per verb and
 * must contain IDs only — see activity.types.ts.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logActivity<V extends ActivityVerb>(args: LogActivityArgs<V>): Promise<void> {
    const schema = activityPayloadSchemas[args.verb];
    const parsed = schema.safeParse(args.payload);
    if (!parsed.success) {
      // A malformed audit payload is a programming error; fail loud rather than
      // silently dropping audit history or leaking PII into the log.
      throw new Error(
        `Invalid activity payload for verb "${args.verb}": ${parsed.error.message}`,
      );
    }

    const db = args.tx ?? this.prisma;
    await db.activity.create({
      data: {
        organizationId: args.organizationId,
        actorUserId: args.actorUserId ?? null,
        subjectType: args.subjectType,
        subjectId: args.subjectId,
        verb: args.verb,
        payload: parsed.data as Prisma.InputJsonValue,
        source: args.source ?? ActivitySource.patrice,
        sourceConnectionId: args.sourceConnectionId ?? null,
      },
    });
  }

  /**
   * Read side for the admin audit view (newest-first, keyset-paginated by `after`).
   * Payloads are IDs-only by discipline (activity.types.ts), so the only PII rendered
   * here is the actor's *current* display name, joined at read time — a scrubbed user
   * keeps its tombstone label, so historical rows still attribute correctly.
   */
  async list(
    organizationId: string,
    filters: ListActivityFilters,
  ): Promise<ActivityListResult> {
    const where: Prisma.ActivityWhereInput = { organizationId };
    if (filters.verb) where.verb = filters.verb;
    else if (filters.verbPrefix) where.verb = { startsWith: filters.verbPrefix };
    if (filters.actorUserId) where.actorUserId = filters.actorUserId;
    if (filters.subjectType) where.subjectType = filters.subjectType;
    if (filters.subjectId) where.subjectId = filters.subjectId;
    if (filters.source) where.source = filters.source;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    // UUIDv7 ids are time-ordered, so `id < after` walks strictly older rows.
    if (filters.after) where.id = { lt: filters.after };

    const rows = await this.prisma.activity.findMany({
      where,
      orderBy: { id: 'desc' },
      take: filters.limit + 1,
    });
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;

    // Batch-resolve actor names for the page (one query, no N+1).
    const actorIds = [
      ...new Set(page.map((r) => r.actorUserId).filter((id): id is string => !!id)),
    ];
    const actors = actorIds.length
      ? await this.prisma.appUser.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(actors.map((a) => [a.id, a.displayName]));

    return {
      items: page.map((r) => ({
        id: r.id,
        actorUserId: r.actorUserId,
        actorName: r.actorUserId ? (nameById.get(r.actorUserId) ?? null) : null,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        verb: r.verb,
        payload: r.payload,
        source: r.source,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
