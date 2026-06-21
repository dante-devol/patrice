import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { GcService } from './gc.service';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * GC admin surface (Slice 7.3). Gated by `config:update` — an Effective-Admin global
 * capability (the seeded Admin holds it). `/gc/sweep` runs the sweep immediately;
 * `/gc/sweep/dry-run` reports what it *would* collect without deleting anything.
 * (The scheduled run is the pg-boss job in {@link GcModule}; these are the manual hooks.)
 */
@Controller('gc')
export class GcController {
  constructor(private readonly gc: GcService) {}

  @Post('sweep')
  @HttpCode(200)
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async sweep(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.gc.sweep();
  }

  @Post('sweep/dry-run')
  @HttpCode(200)
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async dryRun(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.gc.dryRun();
  }
}
