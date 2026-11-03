import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, divisionResource, requestTemplateDivisionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { RequestTemplatesService } from './request-templates.service';
import {
  createRequestTemplateSchema,
  updateRequestTemplateSchema,
  type CreateRequestTemplateDto,
  type UpdateRequestTemplateDto,
} from './request-templates.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * A division's request template library. Every action is a Cedar decision on the
 * template's division, so a division admin can be scoped to their own library.
 */
@Controller()
export class RequestTemplatesController {
  constructor(private readonly requestTemplates: RequestTemplatesService) {}

  @Contract(ROUTES.listDivisionTemplates)
  @Get('divisions/:id/request-templates')
  @Authorize(ACTIONS.requestTemplateRead.action, divisionResource)
  list(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.requestTemplates.listForDivision(id, user.id);
  }

  @Contract(ROUTES.createDivisionTemplate)
  @Post('divisions/:id/request-templates')
  @HttpCode(201)
  @Authorize(ACTIONS.requestTemplateCreate.action, divisionResource)
  create(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createRequestTemplateSchema)) body: CreateRequestTemplateDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.requestTemplates.create(id, user.id, body);
  }

  @Contract(ROUTES.getRequestTemplate)
  @Get('request-templates/:id')
  @Authorize(ACTIONS.requestTemplateRead.action, requestTemplateDivisionResource)
  get(@Param('id') id: string) {
    return this.requestTemplates.get(id);
  }

  @Contract(ROUTES.updateRequestTemplate)
  @Patch('request-templates/:id')
  @Authorize(ACTIONS.requestTemplateUpdate.action, requestTemplateDivisionResource)
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRequestTemplateSchema)) body: UpdateRequestTemplateDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.requestTemplates.update(id, user.id, body);
  }

  @Contract(ROUTES.deleteRequestTemplate)
  @Delete('request-templates/:id')
  @HttpCode(204)
  @Authorize(ACTIONS.requestTemplateDelete.action, requestTemplateDivisionResource)
  async delete(@Param('id') id: string, @CurrentUser() user: CurrentUserRef): Promise<void> {
    await this.requestTemplates.delete(id, user.id);
  }
}
