import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import {
  Authorize,
  taskResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { SubmissionsService } from './submissions.service';
import { submitSchema, type SubmitDto } from './submissions.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Submission endpoints (Slice 5). `task:submit` is gated against the Task resource
 * with the actor as `own_as_claimant`; reads are authenticated-only (§2.3). The
 * review/retire endpoints live on `/submissions/:id` in {@link SubmissionsReviewController}.
 */
@Controller('tasks/:id/submissions')
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Contract(ROUTES.submit)
  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.taskSubmit.action, taskResource)
  async submit(
    @Param('id') taskId: string,
    @Body(new ZodValidationPipe(submitSchema)) body: SubmitDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.submissions.submit(taskId, user.id, body);
  }

  @Contract(ROUTES.listSubmissions)
  @Get()
  @Authorize(ACTIONS.submissionRead.action, taskResource)
  async list(@Param('id') taskId: string) {
    return this.submissions.listForTask(taskId);
  }
}
