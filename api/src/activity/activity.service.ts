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
}
