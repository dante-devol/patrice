import { Injectable } from '@nestjs/common';
import { Prisma, QuestionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { NotFoundError } from '../common/errors';
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
