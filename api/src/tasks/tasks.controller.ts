import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotFoundError, UnauthenticatedError } from '../common/errors';
import {
  Authorize,
  taskCreateResource,
  taskResource,
  taskReviveResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { TasksService } from './tasks.service';
import { QuestionnairesService } from '../questionnaires/questionnaires.service';
import {
  putQuestionnaireSchema,
  type PutQuestionnaireDto,
} from '../questionnaires/questionnaires.dto';
import {
  changeRequesterSchema,
  createTaskSchema,
  listTasksQuerySchema,
  manageClaimsSchema,
  updateTaskSchema,
  type ChangeRequesterDto,
  type CreateTaskDto,
  type ListTasksQuery,
  type ManageClaimsDto,
  type UpdateTaskDto,
} from './tasks.dto';

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Task endpoints (Slice 4.1). Reads (GET) are ungated (authenticated only, per §2.3);
 * mutations declare their `task:*` action against the prospective/loaded Task resource
 * so scoped grants (specific/own division, own_as_requester) are enforced by Cedar.
 */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly questionnaires: QuestionnairesService,
  ) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listTasksQuerySchema)) query: ListTasksQuery,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.list(req.user.organizationId, query);
  }

  @Post()
  @HttpCode(201)
  @Authorize(ACTIONS.taskCreate.action, taskCreateResource)
  async create(
    @Body(new ZodValidationPipe(createTaskSchema)) body: CreateTaskDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.create(req.user.organizationId, req.user.id, body);
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.get(id);
  }

  @Patch(':id')
  @Authorize(ACTIONS.taskUpdate.action, taskResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: UpdateTaskDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.update(id, req.user.id, body);
  }

  @Post(':id/retire')
  @Authorize(ACTIONS.taskRetire.action, taskResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.retire(id, req.user.id);
  }

  @Post(':id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.taskRevive.action, taskReviveResource)
  async revive(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.revive(id, req.user.id);
  }

  @Post(':id/claim')
  @HttpCode(200)
  @Authorize(ACTIONS.taskAssign.action, taskResource)
  async claim(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.claim(id, req.user.id);
  }

  @Post(':id/leave')
  @HttpCode(200)
  @Authorize(ACTIONS.taskAssign.action, taskResource)
  async leave(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.leave(id, req.user.id);
  }

  @Post(':id/claims')
  @HttpCode(200)
  @Authorize(ACTIONS.taskManageClaims.action, taskResource)
  async manageClaims(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(manageClaimsSchema)) body: ManageClaimsDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.manageClaims(id, req.user.id, body);
  }

  @Post(':id/requester')
  @HttpCode(200)
  @Authorize(ACTIONS.taskChangeRequester.action, taskResource)
  async changeRequester(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeRequesterSchema)) body: ChangeRequesterDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.changeRequester(id, req.user.id, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Authorize(ACTIONS.taskComplete.action, taskResource)
  async complete(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.tasks.complete(id, req.user.id);
  }

  @Get(':id/questionnaire')
  async getQuestionnaire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    const qn = await this.questionnaires.getForTask(id);
    if (!qn) {
      throw new NotFoundError(
        'QUESTIONNAIRE_NOT_FOUND',
        'This task has no questionnaire',
      );
    }
    return qn;
  }

  @Put(':id/questionnaire')
  @Authorize(ACTIONS.taskConfigureQuestionnaire.action, taskResource)
  async putQuestionnaire(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(putQuestionnaireSchema)) body: PutQuestionnaireDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.questionnaires.putForTask(id, req.user.id, body);
  }
}
