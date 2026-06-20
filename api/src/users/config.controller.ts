import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { ConfigService } from './config.service';
import { updateConfigSchema, type UpdateConfigDto } from './users.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/** GET/PATCH the structured organization settings (Slice 2.4). */
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async get(@Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.config.get(req.user.organizationId);
  }

  @Patch()
  @Authorize(ACTIONS.configUpdate.action, orgResource)
  async update(
    @Body(new ZodValidationPipe(updateConfigSchema)) body: UpdateConfigDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.config.update(req.user.organizationId, req.user.id, body);
  }
}
