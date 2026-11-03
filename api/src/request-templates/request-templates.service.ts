import { Injectable } from '@nestjs/common';
import { LifecycleState, Prisma, QuestionType, TemplateOrigin } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { AccessService } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { divisionRef } from '../access/entity-loader';
import { diffFields } from '../activity/changes';
import { ConflictError, NotFoundError, UnprocessableError } from '../common/errors';
import {
  CreateRequestTemplateDto,
  PutRequestTemplateDto,
  QuestionInput,
  UpdateRequestTemplateDto,
} from './request-templates.dto';
import type { TemplateChoice } from '../tasks/tasks.dto';

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
  divisionId: string;
  name: string;
  description: string;
  isDefault: boolean;
  version: number;
  questions: QuestionView[];
}

export interface RequestTemplateSummaryView extends Omit<RequestTemplateView, 'questions'> {
  questionCount: number;
}

export interface RequestTemplateLibraryView {
  items: RequestTemplateSummaryView[];
  /** What the caller may do in this division (includes `task:compose_template`). */
  allowedActions: string[];
}

export interface TaskTemplateView {
  taskId: string;
  origin: TemplateOrigin;
  sourceTemplateId: string | null;
  /** True once a live submission exists: the questions can no longer change. */
  locked: boolean;
  questions: QuestionView[];
}

/** A question to snapshot onto a new task. */
export interface SnapshotQuestion {
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: unknown;
  sourceQuestionId: string | null;
}

/** What a task-create template choice resolves to. */
export interface ResolvedTemplate {
  origin: TemplateOrigin;
  sourceTemplateId: string | null;
  questions: SnapshotQuestion[];
}

/** The ids a question-list edit added, removed and changed (audit, by id only). */
interface QuestionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The division actions a library listing reports. */
const LIBRARY_ACTIONS: readonly string[] = [
  ACTIONS.taskCreate.action,
  ACTIONS.taskComposeTemplate.action,
  ACTIONS.requestTemplateCreate.action,
  ACTIONS.requestTemplateUpdate.action,
  ACTIONS.requestTemplateDelete.action,
];

type QuestionRow = {
  id: string;
  ordinal: number;
  type: QuestionType;
  prompt: string;
  required: boolean;
  constraints: Prisma.JsonValue;
};

const toQuestion = (q: QuestionRow): QuestionView => ({
  id: q.id,
  ordinal: q.ordinal,
  type: q.type,
  prompt: q.prompt,
  required: q.required,
  constraints: q.constraints,
});

const questionData = (q: QuestionInput, ordinal: number) => ({
  ordinal,
  type: q.type as QuestionType,
  prompt: q.prompt,
  required: q.required,
  constraints: q.constraints as Prisma.InputJsonValue,
});

/** Question types, recorded as values in audit (prompts and options are by id only). */
const typesOf = (qs: { type: string }[]) => qs.map((q) => q.type);

/**
 * Request templates. A division keeps a **library** of templates, at most one of them
 * the default; a task holds its own **snapshot** of questions, taken from a library
 * template or written by the requester. Answers reference the snapshot, so editing or
 * deleting a library template never touches an existing task.
 */
@Injectable()
export class RequestTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly access: AccessService,
  ) {}

  // ---- Library -----------------------------------------------------------------

  /** The division's library for the picker, plus what the caller may do there. */
  async listForDivision(divisionId: string, userId: string): Promise<RequestTemplateLibraryView> {
    const division = await this.prisma.division.findUnique({
      where: { id: divisionId },
      select: { id: true, restrictClaims: true, allowCustomTemplates: true },
    });
    if (!division) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    const rows = await this.prisma.requestTemplate.findMany({
      where: { divisionId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { questions: true } } },
    });
    const resource = divisionRef(division);
    const allowed = await this.access.decideMany(
      userId,
      LIBRARY_ACTIONS.map((action) => ({ action, resource })),
    );
    return {
      items: rows.map(({ _count, ...t }) => ({ ...this.header(t), questionCount: _count.questions })),
      allowedActions: LIBRARY_ACTIONS.filter((_, i) => allowed[i]),
    };
  }

  async get(id: string): Promise<RequestTemplateView> {
    const t = await this.prisma.requestTemplate.findUnique({
      where: { id },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    if (!t) throw new NotFoundError('REQUEST_TEMPLATE_NOT_FOUND', 'Request template not found');
    return { ...this.header(t), questions: t.questions.map(toQuestion) };
  }

  async create(divisionId: string, actorUserId: string, dto: CreateRequestTemplateDto): Promise<RequestTemplateView> {
    const division = await this.prisma.division.findUnique({
      where: { id: divisionId },
      select: { lifecycleState: true },
    });
    if (!division) throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
    if (division.lifecycleState === LifecycleState.retired) {
      throw new ConflictError('DIVISION_RETIRED', 'Division is retired');
    }
    const id = await this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, divisionId, dto.name);
      if (dto.isDefault) await this.clearDefault(tx, divisionId);
      const t = await tx.requestTemplate.create({
        data: {
          divisionId,
          name: dto.name,
          description: dto.description ?? '',
          isDefault: dto.isDefault ?? false,
        },
      });
      if (dto.questions.length > 0) {
        await tx.requestTemplateQuestion.createMany({
          data: dto.questions.map((q, i) => ({ requestTemplateId: t.id, ...questionData(q, i) })),
        });
      }
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'request_template',
        subjectId: t.id,
        verb: 'request_template.created',
        payload: {
          requestTemplateId: t.id,
          divisionId,
          name: t.name,
          isDefault: t.isDefault,
          questionCount: dto.questions.length,
          questionTypes: typesOf(dto.questions),
        },
      });
      return t.id;
    });
    return this.get(id);
  }

  /** Edit a library template. Tasks made from it keep their own snapshots. */
  async update(id: string, actorUserId: string, dto: UpdateRequestTemplateDto): Promise<RequestTemplateView> {
    const before = await this.prisma.requestTemplate.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('REQUEST_TEMPLATE_NOT_FOUND', 'Request template not found');
    await this.prisma.$transaction(async (tx) => {
      if (dto.name !== undefined && dto.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertNameFree(tx, before.divisionId, dto.name);
      }
      if (dto.isDefault) await this.clearDefault(tx, before.divisionId, id);
      const { count } = await tx.requestTemplate.updateMany({
        where: { id, version: dto.version },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          version: { increment: 1 },
        },
      });
      if (count === 0) {
        throw new ConflictError('STALE_VERSION', 'The template changed since it was read; reload and retry');
      }
      let questions: QuestionDiff | undefined;
      if (dto.questions) {
        const existing = await tx.requestTemplateQuestion.findMany({
          where: { requestTemplateId: id },
          select: { id: true },
        });
        questions = await syncQuestions(existing, dto.questions, {
          shift: () =>
            tx.requestTemplateQuestion.updateMany({
              where: { requestTemplateId: id },
              data: { ordinal: { increment: SHIFT } },
            }),
          remove: (ids) => tx.requestTemplateQuestion.deleteMany({ where: { id: { in: ids } } }),
          update: (qid, data) => tx.requestTemplateQuestion.update({ where: { id: qid }, data }),
          create: async (data) => (await tx.requestTemplateQuestion.create({ data: { requestTemplateId: id, ...data } })).id,
        });
      }
      const after = await tx.requestTemplate.findUniqueOrThrow({
        where: { id },
        include: { questions: { select: { type: true } } },
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'request_template',
        subjectId: id,
        verb: 'request_template.updated',
        payload: {
          requestTemplateId: id,
          divisionId: before.divisionId,
          changes: diffFields(before, after, ['name', 'isDefault']),
          descriptionChanged: dto.description !== undefined && dto.description !== before.description,
          questionCount: after.questions.length,
          questionTypes: typesOf(after.questions),
          ...(questions ? { questions } : {}),
        },
      });
    });
    return this.get(id);
  }

  /** Hard delete with an audit row; tasks keep their snapshots (source becomes null). */
  async delete(id: string, actorUserId: string): Promise<void> {
    const t = await this.prisma.requestTemplate.findUnique({
      where: { id },
      include: { _count: { select: { questions: true } } },
    });
    if (!t) throw new NotFoundError('REQUEST_TEMPLATE_NOT_FOUND', 'Request template not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.requestTemplate.delete({ where: { id } });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'request_template',
        subjectId: id,
        verb: 'request_template.deleted',
        payload: {
          requestTemplateId: id,
          divisionId: t.divisionId,
          name: t.name,
          isDefault: t.isDefault,
          questionCount: t._count.questions,
        },
      });
    });
  }

  // ---- Task snapshots ----------------------------------------------------------

  /**
   * Resolve a task-create template choice in the task's division. A library template
   * must belong to that division; `default` needs the division to have one. The caller
   * authorizes `task:compose_template` for a custom choice.
   */
  async resolveChoice(divisionId: string, choice: TemplateChoice): Promise<ResolvedTemplate> {
    if (choice.kind === 'custom') {
      return {
        origin: TemplateOrigin.custom,
        sourceTemplateId: null,
        questions: choice.questions.map((q) => ({
          type: q.type as QuestionType,
          prompt: q.prompt,
          required: q.required,
          constraints: q.constraints,
          sourceQuestionId: null,
        })),
      };
    }
    const t = await this.prisma.requestTemplate.findFirst({
      where: choice.kind === 'library' ? { id: choice.templateId } : { divisionId, isDefault: true },
      include: { questions: { orderBy: { ordinal: 'asc' } } },
    });
    if (!t) {
      if (choice.kind === 'default') {
        throw new UnprocessableError('TEMPLATE_REQUIRED', 'This division has no default template; pick one');
      }
      throw new NotFoundError('REQUEST_TEMPLATE_NOT_FOUND', 'Request template not found');
    }
    if (t.divisionId !== divisionId) {
      throw new UnprocessableError('TEMPLATE_NOT_IN_DIVISION', 'The template belongs to a different division');
    }
    return {
      origin: TemplateOrigin.library,
      sourceTemplateId: t.id,
      questions: t.questions.map((q) => ({
        type: q.type,
        prompt: q.prompt,
        required: q.required,
        constraints: q.constraints,
        sourceQuestionId: q.id,
      })),
    };
  }

  /** Write a new task's question snapshot (inside the task-create transaction). */
  async snapshot(tx: Prisma.TransactionClient, taskId: string, questions: SnapshotQuestion[]): Promise<void> {
    if (questions.length === 0) return;
    await tx.taskQuestion.createMany({
      data: questions.map((q, ordinal) => ({
        taskId,
        ordinal,
        type: q.type,
        prompt: q.prompt,
        required: q.required,
        constraints: q.constraints as Prisma.InputJsonValue,
        sourceQuestionId: q.sourceQuestionId,
      })),
    });
  }

  async getForTask(taskId: string): Promise<TaskTemplateView> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        templateOrigin: true,
        sourceTemplateId: true,
        questions: { orderBy: { ordinal: 'asc' } },
      },
    });
    if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
    return {
      taskId,
      origin: task.templateOrigin,
      sourceTemplateId: task.sourceTemplateId,
      locked: (await this.liveSubmissionCount(this.prisma, taskId)) > 0,
      questions: task.questions.map(toQuestion),
    };
  }

  /**
   * Edit a task's own questions (`task:configure_request_template`), diffed by id.
   * Locked once a live submission exists. A question that still has answers (from a
   * retired submission) can be edited but not deleted.
   */
  async putForTask(taskId: string, actorUserId: string, dto: PutRequestTemplateDto): Promise<TaskTemplateView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM task WHERE id = ${taskId}::uuid FOR UPDATE`;
      if ((await this.liveSubmissionCount(tx, taskId)) > 0) {
        throw new ConflictError('REQUEST_TEMPLATE_LOCKED', 'The request template is locked once a submission exists');
      }
      const existing = await tx.taskQuestion.findMany({
        where: { taskId },
        select: { id: true, _count: { select: { answers: true } } },
      });
      const answered = new Set(existing.filter((q) => q._count.answers > 0).map((q) => q.id));
      const questions = await syncQuestions(existing, dto.questions, {
        shift: () => tx.taskQuestion.updateMany({ where: { taskId }, data: { ordinal: { increment: SHIFT } } }),
        remove: async (ids) => {
          if (ids.some((id) => answered.has(id))) {
            throw new ConflictError('QUESTION_HAS_ANSWERS', 'A question with answers cannot be deleted');
          }
          await tx.taskQuestion.deleteMany({ where: { id: { in: ids } } });
        },
        update: (id, data) => tx.taskQuestion.update({ where: { id }, data }),
        create: async (data) => (await tx.taskQuestion.create({ data: { taskId, ...data } })).id,
      });
      await this.activity.logActivity({
        tx,
        actorUserId,
        subjectType: 'task',
        subjectId: taskId,
        verb: 'task_request_template.updated',
        payload: {
          taskId,
          questionCount: dto.questions.length,
          questionTypes: typesOf(dto.questions),
          questions,
        },
      });
    });
    return this.getForTask(taskId);
  }

  // ---- Helpers -----------------------------------------------------------------

  private header(t: {
    id: string;
    divisionId: string;
    name: string;
    description: string;
    isDefault: boolean;
    version: number;
  }): Omit<RequestTemplateView, 'questions'> {
    return {
      id: t.id,
      divisionId: t.divisionId,
      name: t.name,
      description: t.description,
      isDefault: t.isDefault,
      version: t.version,
    };
  }

  private liveSubmissionCount(db: Prisma.TransactionClient, taskId: string): Promise<number> {
    return db.submission.count({ where: { taskId, lifecycleState: LifecycleState.active } });
  }

  /** Names are unique per division, ignoring case (the column is citext). */
  private async assertNameFree(tx: Prisma.TransactionClient, divisionId: string, name: string): Promise<void> {
    if (await tx.requestTemplate.findFirst({ where: { divisionId, name }, select: { id: true } })) {
      throw new ConflictError('TEMPLATE_NAME_TAKEN', 'The division already has a template with that name');
    }
  }

  /** Unset the division's current default, so another can take its place. */
  private async clearDefault(tx: Prisma.TransactionClient, divisionId: string, exceptId?: string): Promise<void> {
    await tx.requestTemplate.updateMany({
      where: { divisionId, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }
}

/** Moves every ordinal clear of the final range, so reordering can't collide. */
const SHIFT = 1_000_000;

interface QuestionOps {
  shift(): Promise<unknown>;
  remove(ids: string[]): Promise<unknown>;
  update(id: string, data: ReturnType<typeof questionData>): Promise<unknown>;
  create(data: ReturnType<typeof questionData>): Promise<string>;
}

/**
 * Bring a question set in line with an ordered input list, by id: listed ids are
 * updated in place, unlisted ones deleted, id-less items created. Ids stay stable,
 * which is what keeps answers and audit references valid (register E4).
 */
async function syncQuestions(
  existing: { id: string }[],
  input: QuestionInput[],
  ops: QuestionOps,
): Promise<QuestionDiff> {
  const current = new Set(existing.map((q) => q.id));
  const kept = new Set<string>();
  for (const q of input) {
    if (q.id === undefined) continue;
    if (!current.has(q.id) || kept.has(q.id)) {
      throw new UnprocessableError('UNKNOWN_QUESTION_ID', 'A question id does not belong to this template');
    }
    kept.add(q.id);
  }
  const removed = [...current].filter((id) => !kept.has(id));
  if (removed.length > 0) await ops.remove(removed);
  await ops.shift();
  const added: string[] = [];
  for (const [i, q] of input.entries()) {
    if (q.id === undefined) added.push(await ops.create(questionData(q, i)));
    else await ops.update(q.id, questionData(q, i));
  }
  return { added, removed, changed: [...kept] };
}
