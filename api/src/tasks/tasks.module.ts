import { Module } from '@nestjs/common';
import { RequestTemplatesModule } from '../request-templates/request-templates.module';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskStatusService } from './task-status.service';

@Module({
  imports: [RequestTemplatesModule, MessagesModule, NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskStatusService],
  exports: [TasksService, TaskStatusService],
})
export class TasksModule {}
