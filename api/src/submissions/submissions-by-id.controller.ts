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
import { Authorize, submissionResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { SubmissionsService } from './submissions.service';
import {
  retireSubmissionSchema,
  reviewSchema,
  type ReviewDto,
  type RetireSubmissionDto,
} from './submissions.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Single-submission endpoints (Slice 5) keyed by `/submissions/:id` — the review and
 * retire actions (gated by `task:review` / `task:retire_submission`) plus the
 * authenticated read. Kept apart from the task-scoped collection controller so each
 * route group owns one base path.
 */
@Controller('submissions/:id')
export class SubmissionsByIdController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Get()
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.submissions.get(id);
  }

  @Post('review')
  @HttpCode(200)
  @Authorize(ACTIONS.taskReview.action, submissionResource)
  async review(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reviewSchema)) body: ReviewDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.submissions.review(id, req.user.id, body);
  }

  @Post('retire')
  @HttpCode(200)
  @Authorize(ACTIONS.taskRetireSubmission.action, submissionResource)
  async retire(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(retireSubmissionSchema)) body: RetireSubmissionDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.submissions.retireSubmission(id, req.user.id, body);
  }
}
