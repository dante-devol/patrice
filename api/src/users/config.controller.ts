import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { ConfigService } from './config.service';
import { updateConfigSchema, type UpdateConfigDto } from './users.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/** GET/PATCH the typed system settings (Slice 2.4). */
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Contract(ROUTES.getConfig)
  @Get()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async get() {
    return this.config.get();
  }

  @Contract(ROUTES.updateConfig)
  @Patch()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async update(
    @Body(new ZodValidationPipe(updateConfigSchema)) body: UpdateConfigDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.config.update(user.id, body);
  }
}
