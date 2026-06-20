import { Injectable } from '@nestjs/common';
import { Prisma, QuestionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { PutQuestionnaireDto } from './questionnaires.dto';

export interface QuestionView {
  id: string;
  ordinal: number;
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: unknown;
}

export interface QuestionnaireView {
  id: string;
  ownerDivisionId: string | null;
  ownerTaskId: string | null;
  questions: QuestionView[];
}

/**
 * Division default questionnaires (Slice 3). `put` is **upsert-in-place**: the first
 * call inserts a questionnaire owned by the division (`owner_division_id`); later
 * calls rewrite the question children under the *same* questionnaire row. The
 * UNIQUE on `owner_division_id` is the concurrency backstop — there is never a
 * second questionnaire for a division, so the row's id is stable across edits and
 * the architecture's "editing a default never mutates existing tasks" claim holds
 * (existing task copies are separate rows, owned by their task).
 */
@Injectable()
export class QuestionnairesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** The division's default questionnaire, or null if it has none yet. */
  async getForDivision(divisionId: string): Promise<QuestionnaireView | null> {
    const qn = await this.prisma.questionnaire.findUnique({
      where: { ownerDivisionId: divisionId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    return qn ? this.toView(qn) : null;
  }

  /** A task's own questionnaire copy (Slice 4), or null if the task has none. */
  async getForTask(taskId: string): Promise<QuestionnaireView | null> {
    const qn = await this.prisma.questionnaire.findUnique({
      where: { ownerTaskId: taskId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    return qn ? this.toView(qn) : null;
  }

  /**
   * Edit a task's questionnaire copy in place (`task:configure_questionnaire`). The
   * task's copy is an existing row (seeded at task creation), so this rewrites its
   * question children — it never creates a sibling. In Slice 5 this becomes **locked
   * once a submission exists**; until submissions land (Slice 5) it's always editable.
   * The task's existence/retirement and the actor's authority are checked by the route
   * guard before this runs.
   */
  async putForTask(
    taskId: string,
    actorUserId: string,
    dto: PutQuestionnaireDto,
  ): Promise<QuestionnaireView> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, organizationId: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');

    const questionnaire = await this.prisma.questionnaire.findUnique({
      where: { ownerTaskId: taskId },
      select: { id: true },
    });
    if (!questionnaire) {
      throw new NotFoundError('QUESTIONNAIRE_NOT_FOUND', 'This task has no questionnaire');
    }

    // Lock-at-first-submission (Slice 5): once any non-retired submission exists on the
    // task, the questionnaire is frozen — editing it would orphan captured answers.
    const submissionCount = await this.prisma.submission.count({
      where: { taskId, lifecycleState: 'active' },
    });
    if (submissionCount > 0) {
      throw new ConflictError(
        'QUESTIONNAIRE_LOCKED',
        'The questionnaire is locked once a submission exists',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.question.deleteMany({ where: { questionnaireId: questionnaire.id } });
      if (dto.questions.length > 0) {
        await tx.question.createMany({
          data: dto.questions.map((q, ordinal) => ({
            questionnaireId: questionnaire.id,
            ordinal,
            type: q.type as QuestionType,
            prompt: q.prompt,
            required: q.required,
            constraints: q.constraints as Prisma.InputJsonValue,
          })),
        });
      }
      await tx.questionnaire.update({
        where: { id: questionnaire.id },
        data: { updatedAt: new Date() },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'questionnaire',
        subjectId: questionnaire.id,
        verb: 'task_questionnaire.updated',
        payload: {
          questionnaireId: questionnaire.id,
          taskId,
          questionCount: dto.questions.length,
        },
      });
      return tx.questionnaire.findUniqueOrThrow({
        where: { id: questionnaire.id },
        include: { questions: { orderBy: { ordinal: 'asc' } } },
      });
    });

    return this.toView(result);
  }

  private toView(
    qn: Prisma.QuestionnaireGetPayload<{ include: { questions: true } }>,
  ): QuestionnaireView {
    return {
      id: qn.id,
      ownerDivisionId: qn.ownerDivisionId,
      ownerTaskId: qn.ownerTaskId,
      questions: qn.questions
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((q) => ({
          id: q.id,
          ordinal: q.ordinal,
          type: q.type,
          prompt: q.prompt,
          required: q.required,
          constraints: q.constraints,
        })),
    };
  }

  /**
   * Upsert the division's default questionnaire and replace its question set.
   * The division's existence/retirement and the actor's `division:update` authority
   * are enforced by the route guard before this runs.
   */
  async putForDivision(
    organizationId: string,
    divisionId: string,
    actorUserId: string,
    dto: PutQuestionnaireDto,
  ): Promise<QuestionnaireView> {
    const division = await this.prisma.division.findFirst({
      where: { id: divisionId, organizationId },
      select: { id: true },
    });
    if (!division) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Upsert the owning row; UNIQUE(owner_division_id) keeps it a singleton.
      const existing = await tx.questionnaire.findUnique({
        where: { ownerDivisionId: divisionId },
        select: { id: true },
      });
      const questionnaireId = existing
        ? existing.id
        : (
            await tx.questionnaire.create({
              data: { organizationId, ownerDivisionId: divisionId },
              select: { id: true },
            })
          ).id;

      // Replace the question children in place.
      if (existing) {
        await tx.question.deleteMany({ where: { questionnaireId } });
      }
      if (dto.questions.length > 0) {
        await tx.question.createMany({
          data: dto.questions.map((q, ordinal) => ({
            questionnaireId,
            ordinal,
            type: q.type as QuestionType,
            prompt: q.prompt,
            required: q.required,
            constraints: q.constraints as Prisma.InputJsonValue,
          })),
        });
      }
      await tx.questionnaire.update({
        where: { id: questionnaireId },
        data: { updatedAt: new Date() },
      });

      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'questionnaire',
        subjectId: questionnaireId,
        verb: 'questionnaire.updated',
        payload: {
          questionnaireId,
          divisionId,
          questionCount: dto.questions.length,
        },
      });

      return tx.questionnaire.findUniqueOrThrow({
        where: { id: questionnaireId },
        include: { questions: { orderBy: { ordinal: 'asc' } } },
      });
    });

    return this.toView(result);
  }
}
