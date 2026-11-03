import { Controller, HttpCode, Post } from '@nestjs/common';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { GcService } from './gc.service';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * GC admin surface (Slice 7.3). Gated by `config:update` — an Effective-Admin global
 * capability (the seeded Admin holds it). `/gc/sweep` runs the sweep immediately;
 * `/gc/sweep/dry-run` reports what it *would* collect without deleting anything.
 * (The scheduled run is the pg-boss job in {@link GcModule}; these are the manual hooks.)
 */
@Controller('gc')
export class GcController {
  constructor(private readonly gc: GcService) {}

  @Contract(ROUTES.gcSweep)
  @Post('sweep')
  @HttpCode(200)
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async sweep() {
    return this.gc.sweep();
  }

  @Contract(ROUTES.gcDryRun)
  @Post('sweep/dry-run')
  @HttpCode(200)
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async dryRun() {
    return this.gc.dryRun();
  }
}
