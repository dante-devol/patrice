import { Controller, Get } from '@nestjs/common';
import { Authorize, orgResource } from '../access/authorize.decorator';
import { ACTIONS } from '../access/actions';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';
import { QueueService } from './queue.service';

/** Background job health for admins. */
@Controller('jobs')
export class JobsController {
  constructor(private readonly queue: QueueService) {}

  /** Jobs that ran out of retries, newest first (ids and queues only). */
  @Contract(ROUTES.listDeadLetters)
  @Get('dead-letters')
  @Authorize(ACTIONS.jobRead.action, orgResource)
  deadLetters() {
    return this.queue.deadLetters();
  }
}
