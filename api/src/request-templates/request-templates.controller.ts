import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotFoundError, UnauthenticatedError } from '../common/errors';
import { Authorize, divisionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { RequestTemplatesService } from './request-templates.service';
import {
  putRequestTemplateSchema,
  type PutRequestTemplateDto,
} from './request-templates.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Division default request template endpoints (Slice 3). GET is a read (ungated per
 * §2.3 — authenticated only); PUT is gated `division:update` against the *division*
 * resource, so a `specific_division`-scoped admin can edit only their own division.
 */
@Controller('divisions')
export class RequestTemplatesController {
  constructor(private readonly requestTemplates: RequestTemplatesService) {}

  @Get(':id/request-template')
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    const rt = await this.requestTemplates.getForDivision(id);
    if (!rt) {
      throw new NotFoundError(
        'REQUEST_TEMPLATE_NOT_FOUND',
        'This division has no request template',
      );
    }
    return rt;
  }

  @Put(':id/request-template')
  @Authorize(ACTIONS.divisionUpdate.action, divisionResource)
  async put(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(putRequestTemplateSchema)) body: PutRequestTemplateDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.requestTemplates.putForDivision(
      req.user.organizationId,
      id,
      req.user.id,
      body,
    );
  }
}
