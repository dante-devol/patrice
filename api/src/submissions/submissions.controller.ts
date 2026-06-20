import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import {
  Authorize,
  taskSubmitResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { SubmissionsService } from './submissions.service';
import { submitSchema, type SubmitDto } from './submissions.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Submission endpoints (Slice 5). `task:submit` is gated against the Task resource
 * with the actor as `own_as_claimant`; reads are authenticated-only (§2.3). The
 * review/retire endpoints live on `/submissions/:id` in {@link SubmissionsReviewController}.
 */
@Controller('tasks/:id/submissions')
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.taskSubmit.action, taskSubmitResource)
  async submit(
    @Param('id') taskId: string,
    @Body(new ZodValidationPipe(submitSchema)) body: SubmitDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.submissions.submit(taskId, req.user.id, body);
  }

  @Get()
  async list(@Param('id') taskId: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.submissions.listForTask(taskId);
  }
}
