import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ZodValidationPipe } from '../common/zod.pipe';
import { UnauthenticatedError } from '../common/errors';
import {
  Authorize,
  messageCreateResource,
  messageResource,
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

interface AuthedRequest extends Request {
  user?: { id: string; organizationId: string };
}

/**
 * Message endpoints (Slice 4.3). Listing is an ungated read; creation/edit/retire
 * declare their `message:*` action against the prospective/loaded Message resource so
 * scoped grants (division/team, own_as_sender) are enforced by Cedar.
 */
@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('tasks/:id/messages')
  async list(
    @Param('id') taskId: string,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.messages.listForTask(taskId, query);
  }

  @Post('tasks/:id/messages')
  @HttpCode(201)
  @Authorize(ACTIONS.messageCreate.action, messageCreateResource)
  async create(
    @Param('id') taskId: string,
    @Body(new ZodValidationPipe(createMessageSchema)) body: CreateMessageDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.messages.create(taskId, req.user.id, body);
  }

  @Patch('messages/:id')
  @Authorize(ACTIONS.messageUpdate.action, messageResource)
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateMessageSchema)) body: UpdateMessageDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.user) throw new UnauthenticatedError();
    return this.messages.update(id, req.user.id, body);
  }

  @Post('messages/:id/retire')
  @HttpCode(200)
  @Authorize(ACTIONS.messageRetire.action, messageResource)
  async retire(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthenticatedError();
    return this.messages.retire(id, req.user.id);
  }
}
