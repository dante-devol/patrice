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
