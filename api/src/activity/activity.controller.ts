import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { ActivityService } from './activity.service';
import { listActivityQuerySchema, type ListActivityQuery } from './activity.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * The org-level audit log read surface. Gated by `config:update` — the Effective-Admin
 * global capability (same gate as GC/config), so only governance-holders see the feed.
 * Append-only: there is no write endpoint here (writes go through ActivityService from
 * the actions that generate them).
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async list(
    @Query(new ZodValidationPipe(listActivityQuerySchema)) query: ListActivityQuery,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.activity.list(req.user.organizationId, query);
  }
}
