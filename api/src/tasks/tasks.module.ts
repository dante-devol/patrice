import { Module } from '@nestjs/common';
import { QuestionnairesModule } from '../questionnaires/questionnaires.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [QuestionnairesModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
