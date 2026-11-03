import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe';
import {
  Authorize,
  messageResource,
  taskResource,
} from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { MessagesService } from './messages.service';
import {
  createMessageSchema,
  listMessagesQuerySchema,
  updateMessageSchema,
  type CreateMessageDto,
  type ListMessagesQuery,
  type UpdateMessageDto,
} from './messages.dto';
import { CurrentUser, type CurrentUserRef } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

/**
 * Message endpoints (Slice 4.3). Listing is an ungated read; creation/edit/retire
 * declare their `message:*` action against the prospective/loaded Message resource so
 * scoped grants (division/team, own_as_sender) are enforced by Cedar.
 */
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Contract(ROUTES.listMessages)
  @Get('tasks/:id/messages')
  @Authorize(ACTIONS.messageRead.action, taskResource)
  async list(
    @Param('id') taskId: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    
  ) {
    return this.messages.listForTask(taskId, query);
  }

  @Contract(ROUTES.createMessage)
  @Post('tasks/:id/messages')
  @HttpCode(201)
  @Authorize(ACTIONS.messageCreate.action, taskResource)
  async create(
    @Param('id') taskId: string,
    @Body(new ZodValidationPipe(createMessageSchema)) body: CreateMessageDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.messages.create(taskId, user.id, body);
  }

  @Contract(ROUTES.updateMessage)
  @Patch('messages/:id')
  @Authorize(ACTIONS.messageUpdate.action, messageResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMessageSchema)) body: UpdateMessageDto,
    @CurrentUser() user: CurrentUserRef,
  ) {
    return this.messages.update(id, user.id, body);
  }

  @Contract(ROUTES.retireMessage)
  @Post('messages/:id/retire')
  @HttpCode(200)
  @Authorize(ACTIONS.messageRetire.action, messageResource)
  async retire(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.messages.retire(id, user.id);
  }

  @Contract(ROUTES.reviveMessage)
  @Post('messages/:id/revive')
  @HttpCode(200)
  @Authorize(ACTIONS.messageRevive.action, messageResource)
  async revive(@Param('id') id: string, @CurrentUser() user: CurrentUserRef) {
    return this.messages.revive(id, user.id);
  }
}
