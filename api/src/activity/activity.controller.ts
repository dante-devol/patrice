import { Controller, Get, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { ActivityService } from './activity.service';
import { listActivityQuerySchema, type ListActivityQuery } from './activity.dto';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * The org-level audit log read surface. Gated by `config:update` — the Effective-Admin
 * global capability (same gate as GC/config), so only governance-holders see the feed.
 * Append-only: there is no write endpoint here (writes go through ActivityService from
 * the actions that generate them).
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Contract(ROUTES.listActivity)
  @Get()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async list(
    @Query(new ZodValidationPipe(listActivityQuerySchema)) query: ListActivityQuery,
    
  ) {
    return this.activity.list(query);
  }
}
