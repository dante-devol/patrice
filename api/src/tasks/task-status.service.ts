import { Injectable } from '@nestjs/common';
import { Prisma, StatusCache } from '@prisma/client';
import {
  SubmissionState,
  computeMinRuleStatus,
} from './task-status';

/**
 * DB-backed Status Min-Rule recompute (Slice 5). Reads the task's openings + closed
 * flag and, for each active claimant slot, that claimant's latest non-retired
 * submission state, then writes the rolled-up `status_cache` via {@link
 * computeMinRuleStatus}. Shared by the claim/leave/manage flows (TasksService) and
 * the submit/review/retire flows (SubmissionsService) so every lifecycle event keeps
 * the cache consistent. Always runs inside the caller's transaction.
 */
@Injectable()
export class TaskStatusService {
  async recompute(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<StatusCache> {
    const task = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { openings: true, claimsClosed: true },
    });
    const slots = await tx.taskClaimant.findMany({
      where: { taskId, leftAt: null },
      select: { userId: true },
    });

    const claimantStates: (SubmissionState | null)[] = [];
    for (const slot of slots) {
      const latest = await tx.submission.findFirst({
        where: { taskId, claimantUserId: slot.userId, lifecycleState: 'active' },
        orderBy: { submissionNo: 'desc' },
        select: { state: true },
      });
      claimantStates.push(latest ? (latest.state as SubmissionState) : null);
    }

    const status = computeMinRuleStatus({
      openings: task.openings,
      claimsClosed: task.claimsClosed,
      claimantStates,
    }) as StatusCache;

    await tx.task.update({ where: { id: taskId }, data: { statusCache: status } });
    return status;
  }
}
