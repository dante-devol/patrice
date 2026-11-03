import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import { NotFoundError } from '../common/errors';
import {
  Authorize,
  taskResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { TasksService } from './tasks.service';
import { RequestTemplatesService } from '../request-templates/request-templates.service';
import {
  putRequestTemplateSchema,
  type PutRequestTemplateDto,
} from '../request-templates/request-templates.dto';
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
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Task endpoints (Slice 4.1). Reads (GET) are ungated (authenticated only, per §2.3);
 * mutations declare their `task:*` action against the prospective/loaded Task resource
 * so scoped grants (specific/own division, own_as_requester) are enforced by Cedar.
 */
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly requestTemplates: RequestTemplatesService,
  ) {}

  @Contract(ROUTES.listTasks)
  @Get()
  async list(
    @Query(new ZodValidationPipe(listTasksQuerySchema)) query: ListTasksQuery,
    @CurrentUser() user: CurrentUserRef,
  ) {
    // Visibility is decided per task (task:read) inside the service.
    return this.tasks.list(query, user.id);
  }

  @Contract(ROUTES.createTask)
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createTaskSchema)) body: CreateTaskDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.tasks.create(user.id, body);
  }

  @Contract(ROUTES.getTask)
  @Get(':id')
  @Authorize(ACTIONS.taskRead.action, taskResource)
  async get(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.get(id, user.id);
  }

  @Contract(ROUTES.updateTask)
  @Patch(':id')
  @Authorize(ACTIONS.taskUpdate.action, taskResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: UpdateTaskDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.tasks.update(id, user.id, body);
  }

  @Contract(ROUTES.retireTask)
  @Post(':id/retire')
  @Authorize(ACTIONS.taskRetire.action, taskResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.retire(id, user.id);
  }

  @Contract(ROUTES.reviveTask)
  @Post(':id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.taskRevive.action, taskResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.revive(id, user.id);
  }

  @Contract(ROUTES.claimTask)
  @Post(':id/claim')
  @HttpCode(200)
  @Authorize(ACTIONS.taskAssign.action, taskResource)
  async claim(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.claim(id, user.id);
  }

  @Contract(ROUTES.leaveTask)
  @Post(':id/leave')
  @HttpCode(200)
  @Authorize(ACTIONS.taskLeave.action, taskResource)
  async leave(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.leave(id, user.id);
  }

  @Contract(ROUTES.removeClaimant)
  @Delete(':id/claimants/:userId')
  @HttpCode(200)
  @Authorize(ACTIONS.taskManageClaims.action, taskResource)
  async removeClaimant(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.tasks.removeClaimant(id, user.id, userId);
  }

  @Contract(ROUTES.manageClaims)
  @Post(':id/claims')
  @HttpCode(200)
  @Authorize(ACTIONS.taskManageClaims.action, taskResource)
  async manageClaims(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(manageClaimsSchema)) body: ManageClaimsDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.tasks.manageClaims(id, user.id, body);
  }

  @Contract(ROUTES.changeRequester)
  @Post(':id/requester')
  @HttpCode(200)
  @Authorize(ACTIONS.taskChangeRequester.action, taskResource)
  async changeRequester(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeRequesterSchema)) body: ChangeRequesterDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.tasks.changeRequester(id, user.id, body);
  }

  @Contract(ROUTES.completeTask)
  @Post(':id/complete')
  @HttpCode(200)
  @Authorize(ACTIONS.taskComplete.action, taskResource)
  async complete(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.tasks.complete(id, user.id);
  }

  @Contract(ROUTES.getTaskTemplate)
  @Get(':id/request-template')
  @Authorize(ACTIONS.taskRead.action, taskResource)
  async getRequestTemplate(@Param('id') id: string) {
    const rt = await this.requestTemplates.getForTask(id);
    if (!rt) {
      throw new NotFoundError(
        'REQUEST_TEMPLATE_NOT_FOUND',
        'This task has no request template',
      );
    }
    return rt;
  }

  @Contract(ROUTES.putTaskTemplate)
  @Put(':id/request-template')
  @Authorize(ACTIONS.taskConfigureRequestTemplate.action, taskResource)
  async putRequestTemplate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(putRequestTemplateSchema)) body: PutRequestTemplateDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.requestTemplates.putForTask(id, user.id, body);
  }
}
