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
