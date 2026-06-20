import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { ResourceRef } from './access.service';

export const AUTHORIZE_META = 'patrice:authorize';

/** Resolve the target resource for a request (params/body → Cedar resource). */
export type ResourceResolver = (
  req: Request,
  prisma: PrismaService,
) => ResourceRef | Promise<ResourceRef>;

export interface AuthorizeMeta {
  action: string;
  resolveResource: ResourceResolver;
}

/**
 * Declare the `resource:verb` action a mutating route requires, and how to load
 * its target resource. The AuthorizeGuard evaluates this against the Cedar engine
 * and returns 403 on deny (docs/slices/01 "Authorize guard").
 */
export function Authorize(
  action: string,
  resolveResource: ResourceResolver,
): MethodDecorator {
  return SetMetadata(AUTHORIZE_META, { action, resolveResource } satisfies AuthorizeMeta);
}

/** The singleton organization is the resource for global/create actions. */
export const orgResource: ResourceResolver = async (_req, prisma) => {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  return { type: 'Organization', id: org.id };
};

/**
 * The division named by `:id` is the resource — for `division:update` on a specific
 * division (e.g. its default questionnaire, Slice 3). Carries a `division` self-ref
 * so `specific_division`/`own_division` scopes match, and `retired` so the
 * Retired-as-Hard-Deny blocks edits to a retired division. 404 if it doesn't exist.
 */
export const divisionResource: ResourceResolver = async (req, prisma) => {
  const id = (req.params as Record<string, string>).id;
  const division = await prisma.division.findUnique({
    where: { id },
    select: { id: true, lifecycleState: true },
  });
  if (!division) {
    throw new NotFoundError('DIVISION_NOT_FOUND', 'Division not found');
  }
  return {
    type: 'Division',
    id: division.id,
    attrs: {
      division: { __entity: { type: 'Patrice::Division', id: division.id } },
      retired: division.lifecycleState === 'retired',
    },
  };
};

const divisionEntity = (id: string) => ({
  __entity: { type: 'Patrice::Division', id },
});
const teamEntity = (id: string) => ({ __entity: { type: 'Patrice::Team', id } });
const userEntity = (id: string) => ({ __entity: { type: 'Patrice::User', id } });

/**
 * A **prospective** task is the resource for `task:create` — there is no row yet, so
 * the division/team come from the request body and the requester is the actor. This
 * lets `specific_division`/`own_division`/`own` (own_as_requester) create grants match
 * before the task exists. The guard runs before body validation, so fields are read
 * defensively; a missing division simply fails to match a scoped grant (→ 403).
 */
export const taskCreateResource: ResourceResolver = async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const user = (req as Request & { user?: { id: string } }).user;
  const attrs: Record<string, unknown> = {};
  if (typeof body.divisionId === 'string') attrs.division = divisionEntity(body.divisionId);
  if (typeof body.teamId === 'string') attrs.team = teamEntity(body.teamId);
  if (user) attrs.requester = userEntity(user.id);
  return { type: 'Task', id: 'new', attrs };
};

/**
 * The task named by `:id` is the resource — for `task:update`/`task:retire` and the
 * own-family (`own_as_requester`) scopes. Carries division/team (specific/own group
 * scopes), requester (own), and retired (Retired-as-Hard-Deny). 404 if it's missing.
 */
export const taskResource: ResourceResolver = async (req, prisma) => {
  const id = (req.params as Record<string, string>).id;
  const task = await prisma.task.findUnique({
    where: { id },
    select: {
      id: true,
      divisionId: true,
      teamId: true,
      requesterUserId: true,
      lifecycleState: true,
      division: { select: { restrictClaims: true } },
      team: { select: { restrictClaims: true } },
    },
  });
  if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
  return {
    type: 'Task',
    id: task.id,
    attrs: {
      division: divisionEntity(task.divisionId),
      // Restrict flags drive Claim Eligibility AND-Composition (task:assign).
      // teamRestrictsClaims is always present (false on a teamless task) so the
      // eligibility clause short-circuits without dereferencing resource.team.
      divisionRestrictsClaims: task.division.restrictClaims,
      teamRestrictsClaims: task.team?.restrictClaims ?? false,
      ...(task.teamId ? { team: teamEntity(task.teamId) } : {}),
      requester: userEntity(task.requesterUserId),
      retired: task.lifecycleState === 'retired',
    },
  };
};

/**
 * The task named by `:id` is the resource for `task:submit` — the actor is the
 * `own_as_claimant` owner, so `claimant` is set to the actor **only when they hold an
 * active slot** on the task. A non-claimant (or a claimant who has left) yields no
 * `claimant` attr → the `own` submit grant can't match → Cedar 403. Carries
 * division/team/retired like {@link taskResource}. 404 if the task is missing.
 */
export const taskSubmitResource: ResourceResolver = async (req, prisma) => {
  const id = (req.params as Record<string, string>).id;
  const task = await prisma.task.findUnique({
    where: { id },
    select: {
      id: true,
      divisionId: true,
      teamId: true,
      lifecycleState: true,
    },
  });
  if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
  const user = (req as Request & { user?: { id: string } }).user;
  const slot = user
    ? await prisma.taskClaimant.findUnique({
        where: { taskId_userId: { taskId: id, userId: user.id } },
        select: { leftAt: true },
      })
    : null;
  const isActiveClaimant = !!slot && slot.leftAt === null;
  return {
    type: 'Task',
    id: task.id,
    attrs: {
      division: divisionEntity(task.divisionId),
      ...(task.teamId ? { team: teamEntity(task.teamId) } : {}),
      ...(isActiveClaimant && user ? { claimant: userEntity(user.id) } : {}),
      retired: task.lifecycleState === 'retired',
    },
  };
};

/**
 * The submission named by `:id` resolves to its task as the resource — for
 * `task:review` and `task:retire_submission` (own_as_requester). Carries `requester`
 * (the own-family owner), `claimant` (the reviewed submission's author — drives the
 * self-review forbid), division/team, and `retired` (Retired-as-Hard-Deny over a
 * retired *task*; a retired submission is guarded in the service). 404 if missing.
 */
export const submissionResource: ResourceResolver = async (req, prisma) => {
  const id = (req.params as Record<string, string>).id;
  const submission = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      claimantUserId: true,
      task: {
        select: {
          id: true,
          divisionId: true,
          teamId: true,
          requesterUserId: true,
          lifecycleState: true,
        },
      },
    },
  });
  if (!submission) {
    throw new NotFoundError('SUBMISSION_NOT_FOUND', 'Submission not found');
  }
  const task = submission.task;
  return {
    type: 'Task',
    id: task.id,
    attrs: {
      division: divisionEntity(task.divisionId),
      ...(task.teamId ? { team: teamEntity(task.teamId) } : {}),
      requester: userEntity(task.requesterUserId),
      claimant: userEntity(submission.claimantUserId),
      retired: task.lifecycleState === 'retired',
    },
  };
};

/**
 * A **prospective** message is the resource for `message:create` — the task named by
 * `:id` supplies division/team (specific/own group scopes) and the actor is the
 * sender (own_as_sender). 404 if the task is missing.
 */
export const messageCreateResource: ResourceResolver = async (req, prisma) => {
  const taskId = (req.params as Record<string, string>).id;
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, divisionId: true, teamId: true },
  });
  if (!task) throw new NotFoundError('TASK_NOT_FOUND', 'Task not found');
  const user = (req as Request & { user?: { id: string } }).user;
  return {
    type: 'Message',
    id: 'new',
    attrs: {
      division: divisionEntity(task.divisionId),
      ...(task.teamId ? { team: teamEntity(task.teamId) } : {}),
      ...(user ? { sender: userEntity(user.id) } : {}),
    },
  };
};

/**
 * The message named by `:id` is the resource — for `message:update`/`message:retire`
 * (own_as_sender). Carries its task's division/team, the sender (own), and retired.
 */
export const messageResource: ResourceResolver = async (req, prisma) => {
  const id = (req.params as Record<string, string>).id;
  const message = await prisma.message.findUnique({
    where: { id },
    select: {
      id: true,
      senderUserId: true,
      lifecycleState: true,
      task: { select: { divisionId: true, teamId: true } },
    },
  });
  if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
  return {
    type: 'Message',
    id: message.id,
    attrs: {
      division: divisionEntity(message.task.divisionId),
      ...(message.task.teamId ? { team: teamEntity(message.task.teamId) } : {}),
      ...(message.senderUserId ? { sender: userEntity(message.senderUserId) } : {}),
      retired: message.lifecycleState === 'retired',
    },
  };
};

/**
 * A **prospective** attachment is the resource for `attachment:create` — the target
 * message (the `:id` path param, available before multipart parsing) supplies its
 * task's division/team and the actor is the uploader (own_as_uploader). 404 if the
 * message is missing.
 */
export const attachmentCreateResource: ResourceResolver = async (req, prisma) => {
  const messageId = (req.params as Record<string, string>).id ?? '';
  const message = messageId
    ? await prisma.message.findUnique({
        where: { id: messageId },
        select: { id: true, task: { select: { divisionId: true, teamId: true } } },
      })
    : null;
  if (!message) throw new NotFoundError('MESSAGE_NOT_FOUND', 'Message not found');
  const user = (req as Request & { user?: { id: string } }).user;
  return {
    type: 'Attachment',
    id: 'new',
    attrs: {
      division: divisionEntity(message.task.divisionId),
      ...(message.task.teamId ? { team: teamEntity(message.task.teamId) } : {}),
      ...(user ? { uploader: userEntity(user.id) } : {}),
    },
  };
};
