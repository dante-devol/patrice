import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
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
