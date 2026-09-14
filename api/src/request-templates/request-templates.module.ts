import { Module } from '@nestjs/common';
import { RequestTemplatesController } from './request-templates.controller';
import { RequestTemplatesService } from './request-templates.service';

@Module({
  controllers: [RequestTemplatesController],
  providers: [RequestTemplatesService],
  exports: [RequestTemplatesService],
})
export class RequestTemplatesModule {}
