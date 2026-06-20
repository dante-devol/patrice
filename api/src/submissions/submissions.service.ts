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
import { SubmitDto } from './submissions.dto';

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

      return tx.submission.findUniqueOrThrow({
        where: { id: submission.id },
        include: this.includeAnswers,
      });
    });

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
