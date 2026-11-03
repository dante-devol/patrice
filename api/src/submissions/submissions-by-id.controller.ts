import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { Authorize, submissionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { SubmissionsService } from './submissions.service';
import {
  retireSubmissionSchema,
  reviewSchema,
  type ReviewDto,
  type RetireSubmissionDto,
} from './submissions.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Single-submission endpoints (Slice 5) keyed by `/submissions/:id` — the review and
 * retire actions (gated by `task:review` / `task:retire_submission`) plus the
 * authenticated read. Kept apart from the task-scoped collection controller so each
 * route group owns one base path.
 */
@Controller('submissions/:id')
export class SubmissionsByIdController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Contract(ROUTES.getSubmission)
  @Get()
  @Authorize(ACTIONS.submissionRead.action, submissionResource)
  async get(@Param('id') id: string) {
    return this.submissions.get(id);
  }

  @Contract(ROUTES.reviewSubmission)
  @Post('review')
  @HttpCode(200)
  @Authorize(ACTIONS.taskReview.action, submissionResource)
  async review(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: ReviewDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.submissions.review(id, user.id, body);
  }

  @Contract(ROUTES.retireSubmission)
  @Post('retire')
  @HttpCode(200)
  @Authorize(ACTIONS.taskRetireSubmission.action, submissionResource)
  async retire(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(retireSubmissionSchema)) body: RetireSubmissionDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.submissions.retireSubmission(id, user.id, body);
  }
}
