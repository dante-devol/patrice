import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotFoundError, UnauthenticatedError } from '../common/errors';
import { Authorize, divisionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { QuestionnairesService } from './questionnaires.service';
import {
  putQuestionnaireSchema,
  type PutQuestionnaireDto,
} from './questionnaires.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Division default questionnaire endpoints (Slice 3). GET is a read (ungated per
 * §2.3 — authenticated only); PUT is gated `division:update` against the *division*
 * resource, so a `specific_division`-scoped admin can edit only their own division.
 */
@Controller('divisions')
export class QuestionnairesController {
  constructor(private readonly questionnaires: QuestionnairesService) {}

  @Get(':id/questionnaire')
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    const qn = await this.questionnaires.getForDivision(id);
    if (!qn) {
      throw new NotFoundError(
        'QUESTIONNAIRE_NOT_FOUND',
        'This division has no questionnaire',
      );
    }
    return qn;
  }

  @Put(':id/questionnaire')
  @Authorize(ACTIONS.divisionUpdate.action, divisionResource)
  async put(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(putQuestionnaireSchema)) body: PutQuestionnaireDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.questionnaires.putForDivision(
      req.user.organizationId,
      id,
      req.user.id,
      body,
    );
  }
}
