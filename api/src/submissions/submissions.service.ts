import { Injectable } from '@nestjs/common';
import {
  LifecycleState,
  Prisma,
  QuestionType,
  SubmissionState,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { MessagesService } from '../messages/messages.service';
import { NotificationsService } from '../notifications/notifications.service';
import { REVIEW_DECISION_TYPE } from '../notifications/notification.types';
import { TaskStatusService } from '../tasks/task-status.service';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
} from '../common/errors';
import { validateSubmission } from '../questionnaires/validate-submission';
import {
  Answer,
  AttachmentLookupPort,
  QuestionnaireDef,
} from '../questionnaires/questionnaire.types';
import {
  ReviewDto,
  RetireSubmissionDto,
  SubmitDto,
} from './submissions.dto';

/** Decision → the resulting submission state + the past-tense word for the audit. */
const DECISION_OUTCOME: Readonly<
  Record<ReviewDto['decision'], { state: SubmissionState; verb: string }>
> = {
  approve: { state: SubmissionState.approved, verb: 'approved' },
  return: { state: SubmissionState.revising, verb: 'returned' },
  reject: { state: SubmissionState.rejected, verb: 'rejected' },
};

export interface AnswerView {
  id: string;
  questionId: string;
  value: unknown;
  attachmentIds: string[];
}

export interface SubmissionView {
  id: string;
  taskId: string;
  claimantUserId: string;
  submissionNo: number;
  prevSubmissionId: string | null;
  state: SubmissionState;
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  lifecycleState: LifecycleState;
  version: number;
  answers: AnswerView[];
}

type SubmissionRow = Prisma.SubmissionGetPayload<{
  include: { answers: { include: { attachments: { select: { id: true } } } } };
}>;

/**
 * Submission lifecycle (Slice 5): `task:submit` (validated answer capture + system
 * message M1 + status recompute), `task:review` (approve/return/reject under a
 * state-machine guard + version-guarded UPDATE), and `task:retire_submission`. Cedar
 * has already gated *who* may act before any method here runs; the service enforces
 * the operational invariants (claimant holds a slot, valid state transition, the
 * questionnaire lock) and keeps `status_cache` consistent via the Min-Rule.
 */
@Injectable()
export class SubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly messages: MessagesService,
    private readonly notifications: NotificationsService,
    private readonly status: TaskStatusService,
  ) {}

  private toView(s: SubmissionRow): SubmissionView {
    return {
      id: s.id,
      taskId: s.taskId,
      claimantUserId: s.claimantUserId,
      submissionNo: s.submissionNo,
      prevSubmissionId: s.prevSubmissionId,
      state: s.state,
      submittedAt: s.submittedAt,
      reviewedBy: s.reviewedBy,
      reviewedAt: s.reviewedAt,
      lifecycleState: s.lifecycleState,
      version: s.version,
      answers: s.answers.map((a) => ({
        id: a.id,
        questionId: a.questionId,
        value: a.value,
        attachmentIds: a.attachments.map((att) => att.id),
      })),
    };
  }

  private readonly includeAnswers = {
    answers: { include: { attachments: { select: { id: true } } } },
  } as const;

  /**
   * Capture a claimant's answers (`task:submit`). Validates via the Slice-3
   * `validateSubmission` (422 on failure), then in one transaction creates the
   * `submission` (next `submission_no`, chained to the returned prior version),
   * persists `answer` rows, re-owns referenced attachments to those answers, marks
   * the slot submitted, emits system message M1, and recomputes `status_cache`.
   */
  async submit(
    taskId: string,
    actorUserId: string,
    dto: SubmitDto,
  ): Promise<SubmissionView> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, organizationId: true, lifecycleState: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    if (task.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('TASK_RETIRED', 'Task is retired');
    }

    const slot = await this.prisma.taskClaimant.findUnique({
      where: { taskId_userId: { taskId, userId: actorUserId } },
      select: { leftAt: true },
    });
    if (!slot || slot.leftAt !== null) {
      throw new ConflictError('NOT_CLAIMED', 'You do not hold a slot on this task');
    }

    const questionnaire = await this.prisma.questionnaire.findUnique({
      where: { ownerTaskId: taskId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    if (!questionnaire) {
      throw new NotFoundError('QUESTIONNAIRE_NOT_FOUND', 'This task has no questionnaire');
    }

    const qnDef: QuestionnaireDef = {
      id: questionnaire.id,
      questions: questionnaire.questions.map((q) => ({
        id: q.id,
        ordinal: q.ordinal,
        type: q.type as QuestionnaireDef['questions'][number]['type'],
        prompt: q.prompt,
        required: q.required,
        constraints: q.constraints as never,
      })),
    };
    const typeById = new Map(questionnaire.questions.map((q) => [q.id, q.type]));
    const answers: Answer[] = dto.answers.map((a) =>
      toValidatorAnswer(typeById.get(a.questionId), a),
    );

    const lookup: AttachmentLookupPort = async (attId) => {
      const att = await this.prisma.attachment.findFirst({
        where: {
          id: attId,
          organizationId: task.organizationId,
          lifecycleState: LifecycleState.active,
        },
        select: { contentType: true, kind: true },
      });
      return att ? { contentType: att.contentType, kind: att.kind } : null;
    };

    const result = await validateSubmission(qnDef, answers, lookup);
    if (!result.ok) {
      throw new UnprocessableError(
        'INVALID_SUBMISSION',
        'Submission answers are invalid',
        result.errors,
      );
    }

    let notified: string[] = [];
    const created = await this.prisma.$transaction(async (tx) => {
      // Serialize concurrent submits by this claimant so submission_no is race-safe.
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;

      const latest = await tx.submission.findFirst({
        where: { taskId, claimantUserId: actorUserId },
        orderBy: { submissionNo: 'desc' },
        select: { id: true, submissionNo: true, state: true, lifecycleState: true },
      });
      // A resubmission is only valid from a returned (`revising`) active version.
      if (latest && latest.lifecycleState === LifecycleState.active) {
        if (latest.state !== SubmissionState.revising) {
          throw new ConflictError(
            'ALREADY_SUBMITTED',
            'Your current submission is not awaiting a resubmission',
          );
        }
      }
      const submissionNo = (latest?.submissionNo ?? 0) + 1;
      const prevSubmissionId =
        latest && latest.lifecycleState === LifecycleState.active
          ? latest.id
          : null;

      const submission = await tx.submission.create({
        data: {
          taskId,
          claimantUserId: actorUserId,
          submissionNo,
          prevSubmissionId,
          state: SubmissionState.review,
          submittedAt: new Date(),
        },
        select: { id: true },
      });

      for (const dtoAnswer of dto.answers) {
        const answer = await tx.answer.create({
          data: {
            submissionId: submission.id,
            questionId: dtoAnswer.questionId,
            value:
              dtoAnswer.value === undefined || dtoAnswer.value === null
                ? Prisma.JsonNull
                : (dtoAnswer.value as Prisma.InputJsonValue),
          },
          select: { id: true },
        });
        if (dtoAnswer.attachmentIds && dtoAnswer.attachmentIds.length > 0) {
          // Re-own referenced attachments to this answer (message XOR answer CHECK
          // stays satisfied: answer_id set, message_id cleared).
          await tx.attachment.updateMany({
            where: {
              id: { in: dtoAnswer.attachmentIds },
              organizationId: task.organizationId,
            },
            data: { answerId: answer.id, messageId: null },
          });
        }
      }

      await tx.taskClaimant.update({
        where: { taskId_userId: { taskId, userId: actorUserId } },
        data: { hasSubmitted: true },
      });

      // System message M1 — the top-level host of this submission's review thread.
      await this.messages.createSystemMessage(
        tx,
        taskId,
        `User ${actorUserId} submitted version ${submissionNo}.`,
        { submissionId: submission.id },
      );

      await this.status.recompute(tx, taskId);

      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'submission',
        subjectId: submission.id,
        verb: 'submission.submitted',
        payload: {
          taskId,
          submissionId: submission.id,
          claimantUserId: actorUserId,
          submissionNo,
        },
      });

      // Notify the task requester (sender — the claimant — is suppressed).
      notified = await this.notifications.emit(tx, {
        organizationId: task.organizationId,
        type: 'task.submitted',
        subjectType: 'submission',
        subjectId: submission.id,
        senderUserId: actorUserId,
        recipientUserIds: [await this.notifications.requesterId(tx, taskId)],
        payload: { taskId, submissionId: submission.id, actorUserId },
      });

      return tx.submission.findUniqueOrThrow({
        where: { id: submission.id },
        include: this.includeAnswers,
      });
    });

    this.notifications.publish(notified);
    return this.toView(created);
  }

  /**
   * List a task's submissions. Cedar leaves reads ungated in v1 (§2.3); the caller's
   * controller authenticates. Newest-first by `submission_no` within claimant.
   */
  async listForTask(taskId: string): Promise<SubmissionView[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    const rows = await this.prisma.submission.findMany({
      where: { taskId, lifecycleState: LifecycleState.active },
      orderBy: [{ claimantUserId: 'asc' }, { submissionNo: 'desc' }],
      include: this.includeAnswers,
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * Review a submission (`task:review`): approve / return / reject. Cedar has gated
   * *who* (and the self-review forbid); here the **state-machine guard** gates the
   * transition — only a submission in `review` may move — and the UPDATE is
   * **version-guarded** (409 STALE_SUBMISSION on a lost optimistic-lock race). The
   * decision is recorded as a system reply threaded under the submission's M1, an
   * optional reviewer `comment` as a user reply, then `status_cache` is recomputed.
   */
  async review(
    submissionId: string,
    actorUserId: string,
    dto: ReviewDto,
  ): Promise<SubmissionView> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        taskId: true,
        claimantUserId: true,
        submissionNo: true,
        state: true,
        version: true,
        lifecycleState: true,
        task: { select: { organizationId: true } },
      },
    });
    if (!submission) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'Submission not found');
    }
    if (submission.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('SUBMISSION_RETIRED', 'Submission is retired');
    }
    // State-machine guard: a decision is only valid from `review`. Once a submission
    // leaves `review` that row is terminal; further iteration is a new submission.
    if (submission.state !== SubmissionState.review) {
      throw new ConflictError(
        'INVALID_TRANSITION',
        `Cannot review a submission in state "${submission.state}"`,
      );
    }
    const outcome = DECISION_OUTCOME[dto.decision];

    let notified: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      // Version-guarded UPDATE — 0 rows means another writer moved it first.
      const updated = await tx.submission.updateMany({
        where: { id: submissionId, version: submission.version },
        data: {
          state: outcome.state,
          reviewedBy: actorUserId,
          reviewedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictError(
          'STALE_SUBMISSION',
          'This submission changed since you loaded it; reload and retry',
        );
      }

      // The decision is a system reply under the submission's M1 top-level message.
      const m1 = await tx.message.findFirst({
        where: {
          taskId: submission.taskId,
          submissionId,
          parentMessageId: null,
          kind: 'system',
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      await this.messages.createSystemMessage(
        tx,
        submission.taskId,
        `Reviewer ${actorUserId} ${outcome.verb} version ${submission.submissionNo}.`,
        { submissionId, parentMessageId: m1?.id ?? null },
      );
      if (dto.comment) {
        await tx.message.create({
          data: {
            taskId: submission.taskId,
            kind: 'comment',
            senderUserId: actorUserId,
            parentMessageId: m1?.id ?? null,
            submissionId,
            body: dto.comment,
          },
        });
      }

      const status = await this.status.recompute(tx, submission.taskId);
      await this.activity.logActivity({
        tx,
        organizationId: submission.task.organizationId,
        actorUserId,
        subjectType: 'submission',
        subjectId: submissionId,
        verb: 'submission.reviewed',
        payload: {
          taskId: submission.taskId,
          submissionId,
          decision: dto.decision,
          statusCache: status,
        },
      });

      // Notify the submission's claimant of the decision (reviewer is suppressed —
      // self-review is forbidden by Cedar anyway, this is the backstop).
      notified = await this.notifications.emit(tx, {
        organizationId: submission.task.organizationId,
        type: REVIEW_DECISION_TYPE[dto.decision],
        subjectType: 'submission',
        subjectId: submissionId,
        senderUserId: actorUserId,
        recipientUserIds: [submission.claimantUserId],
        payload: { taskId: submission.taskId, submissionId, decision: dto.decision },
      });
    });

    this.notifications.publish(notified);
    return this.get(submissionId);
  }

  /**
   * Retire a submission (`task:retire_submission`, requester own-family). Requires a
   * 5..500-char reason (enforced at the DTO). In one transaction: writes a **task-level
   * audit message** (`submission_id=NULL` so it survives submission GC), soft-retires
   * the submission, **cascade-retires** its M1 + every reply (`submission_id=sub.id`),
   * reverts the claimant slot (`has_submitted=false` → claimable again), recomputes
   * `status_cache`, and logs the org-level `submission.retired` activity.
   */
  async retireSubmission(
    submissionId: string,
    actorUserId: string,
    dto: RetireSubmissionDto,
  ): Promise<SubmissionView> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        taskId: true,
        submissionNo: true,
        claimantUserId: true,
        lifecycleState: true,
        task: { select: { organizationId: true } },
      },
    });
    if (!submission) {
      throw new NotFoundError('SUBMISSION_NOT_FOUND', 'Submission not found');
    }
    if (submission.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('ALREADY_RETIRED', 'Submission is already retired');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 1. Task-level audit message — submission_id NULL so the cascade (step 3) and
      //    submission GC both leave it standing.
      await tx.message.create({
        data: {
          taskId: submission.taskId,
          kind: 'system',
          senderUserId: null,
          submissionId: null,
          parentMessageId: null,
          body: JSON.stringify({
            verb: 'submission_retired',
            submissionNo: submission.submissionNo,
            claimantUserId: submission.claimantUserId,
            retiredBy: actorUserId,
            reason: dto.reason,
          }),
        },
      });

      // 2. Soft-retire the submission row.
      await tx.submission.update({
        where: { id: submissionId },
        data: {
          lifecycleState: LifecycleState.retired,
          retiredAt: now,
          version: { increment: 1 },
        },
      });

      // 3. Cascade — soft-retire M1 + every reply bound to this submission's thread.
      await tx.message.updateMany({
        where: { submissionId, lifecycleState: LifecycleState.active },
        data: { lifecycleState: LifecycleState.retired, retiredAt: now },
      });

      // 4. Revert the claimant slot — the spot is claimable again.
      await tx.taskClaimant.updateMany({
        where: { taskId: submission.taskId, userId: submission.claimantUserId },
        data: { hasSubmitted: false },
      });

      // 5. Recompute status.
      await this.status.recompute(tx, submission.taskId);

      // 6. Org-level audit (distinct from the task-thread audit message in step 1).
      await this.activity.logActivity({
        tx,
        organizationId: submission.task.organizationId,
        actorUserId,
        subjectType: 'submission',
        subjectId: submissionId,
        verb: 'submission.retired',
        payload: {
          taskId: submission.taskId,
          submissionId,
          claimantUserId: submission.claimantUserId,
          reason: dto.reason,
        },
      });
    });

    return this.get(submissionId);
  }

  async get(id: string): Promise<SubmissionView> {
    const row = await this.prisma.submission.findUnique({
      where: { id },
      include: this.includeAnswers,
    });
    if (!row) throw new NotFoundError('SUBMISSION_NOT_FOUND', 'Submission not found');
    return this.toView(row);
  }
}

/** Map a polymorphic DTO answer onto the validator's typed answer shape. */
function toValidatorAnswer(
  type: QuestionType | undefined,
  a: { questionId: string; value?: string | number | string[] | null; attachmentIds?: string[] },
): Answer {
  switch (type) {
    case 'detail_text':
    case 'multiline':
    case 'text':
      return {
        questionId: a.questionId,
        text: a.value == null ? null : String(a.value),
      };
    case 'numeric':
      return {
        questionId: a.questionId,
        number:
          typeof a.value === 'number'
            ? a.value
            : a.value == null
              ? null
              : Number(a.value),
      };
    case 'dropdown':
    case 'radio':
      return {
        questionId: a.questionId,
        selected: Array.isArray(a.value)
          ? a.value
          : a.value == null
            ? null
            : [String(a.value)],
      };
    case 'attachment':
      return { questionId: a.questionId, attachmentIds: a.attachmentIds ?? null };
    default:
      // Unknown question id — surface as text so validateSubmission flags it.
      return {
        questionId: a.questionId,
        text: a.value == null ? null : String(a.value),
      };
  }
}
