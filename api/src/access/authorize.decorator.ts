import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ORGANIZATION_RESOURCE, ResourceRef } from './access.service';
import { EntityLoader } from './entity-loader';

export const AUTHORIZE_META = 'patrice:authorize';

/** Resolve the target resource for a request. Reads validated path params only. */
export type ResourceResolver = (
  req: Request,
  prisma: PrismaService,
) => ResourceRef | Promise<ResourceRef>;

export interface AuthorizeMeta {
  action: string;
  resolveResource: ResourceResolver;
}

/**
 * Declare the `resource:verb` action a route requires and how to load its target.
 * The AuthorizeGuard evaluates it with Cedar and returns 403 on deny. Every resolver
 * below delegates to the {@link EntityLoader}, the one place Cedar resources are built.
 */
export function Authorize(action: string, resolveResource: ResourceResolver): MethodDecorator {
  return SetMetadata(AUTHORIZE_META, { action, resolveResource } satisfies AuthorizeMeta);
}

const param = (req: Request, name = 'id'): string => String((req.params as Record<string, string>)[name]);

/** The fixed Organization entity: the resource for org-wide actions. */
export const orgResource: ResourceResolver = () => ORGANIZATION_RESOURCE;

/** `:id` is a task. */
export const taskResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).task(param(req));
/** `:id` is a submission; the resource is its task, with the submission's author. */
export const submissionResource: ResourceResolver = (req, prisma) =>
  new EntityLoader(prisma).submissionTask(param(req));
/** `:id` is a message. */
export const messageResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).message(param(req));
/** `:id` is an attachment; the resource is the attachment itself. */
export const attachmentResource: ResourceResolver = (req, prisma) =>
  new EntityLoader(prisma).attachment(param(req));
/** `:id` is an attachment; the resource is its task (for `attachment:read`). */
export const attachmentTaskResource: ResourceResolver = (req, prisma) =>
  new EntityLoader(prisma).attachmentTask(param(req));
/** `:id` is a division. */
export const divisionResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).division(param(req));
/** `:id` is a team. */
export const teamResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).team(param(req));
/** `:id` is a user. */
export const userResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).user(param(req));
/** `:id` is a user and `:roleId` (or body `roleId`) the role being given or taken. */
export const userWithRoleResource: ResourceResolver = (req, prisma) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const roleId = (req.params as Record<string, string>).roleId ?? (typeof body.roleId === 'string' ? body.roleId : '');
  return new EntityLoader(prisma).user(param(req), roleId);
};
/** `:id` is an invitation. */
export const invitationResource: ResourceResolver = (req, prisma) =>
  new EntityLoader(prisma).invitation(param(req));
/** `:id` is a session. */
export const sessionResource: ResourceResolver = (req, prisma) => new EntityLoader(prisma).session(param(req));
/**
 * Stands for "every session of user `:id`", for listing a user's sessions. Same rule
 * as revoking one: yourself always, anyone else with a grant.
 */
export const userSessionsResource: ResourceResolver = (req, prisma) =>
  new EntityLoader(prisma).sessionsOf(param(req));
