import { Module } from '@nestjs/common';
import { QuestionnairesModule } from '../questionnaires/questionnaires.module';
import { MessagesModule } from '../messages/messages.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskStatusService } from './task-status.service';

@Module({
  imports: [QuestionnairesModule, MessagesModule, NotificationsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskStatusService],
  exports: [TasksService, TaskStatusService],
})
export class TasksModule {}
