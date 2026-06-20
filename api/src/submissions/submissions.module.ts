import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MessagesModule } from '../messages/messages.module';
import { SubmissionsService } from './submissions.service';
import { SubmissionsController } from './submissions.controller';
import { SubmissionsByIdController } from './submissions-by-id.controller';

@Module({
  imports: [TasksModule, MessagesModule],
  controllers: [SubmissionsController, SubmissionsByIdController],
  providers: [SubmissionsService],
  exports: [SubmissionsService],
})
export class SubmissionsModule {}
