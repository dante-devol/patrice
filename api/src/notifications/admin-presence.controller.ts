import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { AdminPresenceService } from './admin-presence.service';
import { adminPresenceSchema, type AdminPresenceDto } from './admin-presence.dto';

/** An admin editor says it holds unsaved changes, dropped them, or saved them. */
@Controller('admin')
export class AdminPresenceController {
  constructor(private readonly presence: AdminPresenceService) {}

  @Contract(ROUTES.announceAdminPresence)
  @Post('presence')
  @HttpCode(204)
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async announce(
    @Body(new ZodValidationPipe(adminPresenceSchema)) body: AdminPresenceDto,
    @CurrentUser() user: CurrentUserRef,
  ): Promise<void> {
    await this.presence.announce(user.id, body);
  }
}
