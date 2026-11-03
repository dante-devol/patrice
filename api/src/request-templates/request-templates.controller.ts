import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotFoundError } from '../common/errors';
import { Authorize, divisionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { RequestTemplatesService } from './request-templates.service';
import {
  putRequestTemplateSchema,
  type PutRequestTemplateDto,
} from './request-templates.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Division default request template endpoints (Slice 3). GET is a read (ungated per
 * §2.3 — authenticated only); PUT is gated `division:update` against the *division*
 * resource, so a `specific_division`-scoped admin can edit only their own division.
 */
@Controller('divisions')
export class RequestTemplatesController {
  constructor(private readonly requestTemplates: RequestTemplatesService) {}

  @Contract(ROUTES.getDivisionTemplate)
  @Get(':id/request-template')
  @Authorize(ACTIONS.requestTemplateRead.action, divisionResource)
  async get(@Param('id') id: string) {
    const rt = await this.requestTemplates.getForDivision(id);
    if (!rt) {
      throw new NotFoundError(
        'REQUEST_TEMPLATE_NOT_FOUND',
        'This division has no request template',
      );
    }
    return rt;
  }

  @Contract(ROUTES.putDivisionTemplate)
  @Put(':id/request-template')
  @Authorize(ACTIONS.divisionUpdate.action, divisionResource)
  async put(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(putRequestTemplateSchema)) body: PutRequestTemplateDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.requestTemplates.putForDivision(
      id,
      user.id,
      body,
    );
  }
}
