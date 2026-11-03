import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, StatusCache } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubmissionState, deriveStatus } from './task-status';

/**
 * Feeds {@link deriveStatus} from the database and stores the result in
 * `status_cache`. A seat's contribution is its claimant's latest live submission
 * **in their current tenure** (submitted since they last took the seat), so work
 * from an earlier tenure (before an eviction or a retired submission) never counts.
 */
@Injectable()
export class TaskStatusService {
  constructor(private readonly prisma: PrismaService) {}

  /** Recompute and store one task's status, inside the caller's transaction. */
  async recompute(tx: Prisma.TransactionClient, taskId: string): Promise<StatusCache> {
    const status = await this.derive(tx, taskId);
    await tx.task.update({ where: { id: taskId }, data: { statusCache: status } });
    return status;
  }

  /** The status the facts give, without storing it. */
  async derive(db: Prisma.TransactionClient, taskId: string): Promise<StatusCache> {
    const task = await db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { openings: true, claimsClosed: true, completedAt: true },
    });
    const seats = await db.taskClaimant.findMany({
      where: { taskId, leftAt: null },
      select: { userId: true, joinedAt: true },
    });
    const claimantStates: (SubmissionState | null)[] = [];
    for (const seat of seats) {
      const latest = await db.submission.findFirst({
        where: {
          taskId,
          claimantUserId: seat.userId,
          lifecycleState: LifecycleState.active,
          submittedAt: { gte: seat.joinedAt },
        },
        orderBy: { submissionNo: 'desc' },
        select: { state: true },
      });
      claimantStates.push(latest ? latest.state : null);
    }
    return deriveStatus({
      completed: task.completedAt !== null,
      openings: task.openings,
      claimsClosed: task.claimsClosed,
      claimantStates,
    }) as StatusCache;
  }

  /**
   * Rebuild every stored status from the facts. Returns the ids whose cache was
   * wrong (and is now fixed), so a check can report drift.
   */
  async rebuild(): Promise<string[]> {
    const tasks = await this.prisma.task.findMany({ select: { id: true, statusCache: true } });
    const fixed: string[] = [];
    for (const t of tasks) {
      const status = await this.derive(this.prisma, t.id);
      if (status !== t.statusCache) {
        await this.prisma.task.update({ where: { id: t.id }, data: { statusCache: status } });
        fixed.push(t.id);
      }
    }
    return fixed;
  }
}
