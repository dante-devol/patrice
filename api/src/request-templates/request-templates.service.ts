import { Injectable } from '@nestjs/common';
import { Prisma, QuestionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { PutRequestTemplateDto } from './request-templates.dto';

export interface QuestionView {
  id: string;
  ordinal: number;
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: unknown;
}

export interface RequestTemplateView {
  id: string;
  ownerDivisionId: string | null;
  ownerTaskId: string | null;
  questions: QuestionView[];
}

/**
 * Division default request templates (Slice 3). `put` is **upsert-in-place**: the
 * first call inserts a request template owned by the division (`owner_division_id`);
 * later calls rewrite the question children under the *same* request template row.
 * The UNIQUE on `owner_division_id` is the concurrency backstop — there is never a
 * second request template for a division, so the row's id is stable across edits and
 * the architecture's "editing a default never mutates existing tasks" claim holds
 * (existing task copies are separate rows, owned by their task).
 */
@Injectable()
export class RequestTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** The division's default request template, or null if it has none yet. */
  async getForDivision(divisionId: string): Promise<RequestTemplateView | null> {
    const rt = await this.prisma.requestTemplate.findUnique({
      where: { ownerDivisionId: divisionId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    return rt ? this.toView(rt) : null;
  }

  /** A task's own request template copy (Slice 4), or null if the task has none. */
  async getForTask(taskId: string): Promise<RequestTemplateView | null> {
    const rt = await this.prisma.requestTemplate.findUnique({
      where: { ownerTaskId: taskId },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    return rt ? this.toView(rt) : null;
  }

  /**
   * Edit a task's request template copy in place (`task:configure_request_template`).
   * The task's copy is an existing row (seeded at task creation), so this rewrites its
   * question children — it never creates a sibling. In Slice 5 this becomes **locked
   * once a submission exists**; until submissions land (Slice 5) it's always editable.
   * The task's existence/retirement and the actor's authority are checked by the route
   * guard before this runs.
   */
  async putForTask(
    taskId: string,
    actorUserId: string,
    dto: PutRequestTemplateDto,
  ): Promise<RequestTemplateView> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, organizationId: true },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');

    const requestTemplate = await this.prisma.requestTemplate.findUnique({
      where: { ownerTaskId: taskId },
      select: { id: true },
    });
    if (!requestTemplate) {
      throw new NotFoundError('REQUEST_TEMPLATE_NOT_FOUND', 'This task has no request template');
    }

    // Lock-at-first-submission (Slice 5): once any non-retired submission exists on the
    // task, the request template is frozen — editing it would orphan captured answers.
    const submissionCount = await this.prisma.submission.count({
      where: { taskId, lifecycleState: 'active' },
    });
    if (submissionCount > 0) {
      throw new ConflictError(
        'REQUEST_TEMPLATE_LOCKED',
        'The request template is locked once a submission exists',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.question.deleteMany({ where: { requestTemplateId: requestTemplate.id } });
      if (dto.questions.length > 0) {
        await tx.question.createMany({
          data: dto.questions.map((q, ordinal) => ({
            requestTemplateId: requestTemplate.id,
            ordinal,
            type: q.type as QuestionType,
            prompt: q.prompt,
            required: q.required,
            constraints: q.constraints as Prisma.InputJsonValue,
          })),
        });
      }
      await tx.requestTemplate.update({
        where: { id: requestTemplate.id },
        data: { updatedAt: new Date() },
      });
      await this.activity.logActivity({
        tx,
        organizationId: task.organizationId,
        actorUserId,
        subjectType: 'request_template',
        subjectId: requestTemplate.id,
        verb: 'task_request_template.updated',
        payload: {
          requestTemplateId: requestTemplate.id,
          taskId,
          questionCount: dto.questions.length,
        },
      });
      return tx.requestTemplate.findUniqueOrThrow({
        where: { id: requestTemplate.id },
        include: { questions: { orderBy: { ordinal: 'asc' } } },
      });
    });

    return this.toView(result);
  }

  private toView(
    rt: Prisma.RequestTemplateGetPayload<{ include: { questions: true } }>,
  ): RequestTemplateView {
    return {
      id: rt.id,
      ownerDivisionId: rt.ownerDivisionId,
      ownerTaskId: rt.ownerTaskId,
      questions: rt.questions
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
   * Upsert the division's default request template and replace its question set.
   * The division's existence/retirement and the actor's `division:update` authority
   * are enforced by the route guard before this runs.
   */
  async putForDivision(
    organizationId: string,
    divisionId: string,
    actorUserId: string,
    dto: PutRequestTemplateDto,
  ): Promise<RequestTemplateView> {
    const division = await this.prisma.division.findFirst({
      where: { id: divisionId, organizationId },
      select: { id: true },
    });
    if (!division) {
      throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Upsert the owning row; UNIQUE(owner_division_id) keeps it a singleton.
      const existing = await tx.requestTemplate.findUnique({
        where: { ownerDivisionId: divisionId },
        select: { id: true },
      });
      const requestTemplateId = existing
        ? existing.id
        : (
            await tx.requestTemplate.create({
              data: { organizationId, ownerDivisionId: divisionId },
              select: { id: true },
            })
          ).id;

      // Replace the question children in place.
      if (existing) {
        await tx.question.deleteMany({ where: { requestTemplateId } });
      }
      if (dto.questions.length > 0) {
        await tx.question.createMany({
          data: dto.questions.map((q, ordinal) => ({
            requestTemplateId,
            ordinal,
            type: q.type as QuestionType,
            prompt: q.prompt,
            required: q.required,
            constraints: q.constraints as Prisma.InputJsonValue,
          })),
        });
      }
      await tx.requestTemplate.update({
        where: { id: requestTemplateId },
        data: { updatedAt: new Date() },
      });

      await this.activity.logActivity({
        tx,
        organizationId,
        actorUserId,
        subjectType: 'request_template',
        subjectId: requestTemplateId,
        verb: 'request_template.updated',
        payload: {
          requestTemplateId,
          divisionId,
          questionCount: dto.questions.length,
        },
      });

      return tx.requestTemplate.findUniqueOrThrow({
        where: { id: requestTemplateId },
        include: { questions: { orderBy: { ordinal: 'asc' } } },
      });
    });

    return this.toView(result);
  }
}
