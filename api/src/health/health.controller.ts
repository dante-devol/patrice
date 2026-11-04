import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { Public } from '../auth/current-user';
import { Contract } from '../contract/contract.decorator';
import { ROUTES } from '../contract/routes';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Liveness, a DB ping and the job queue. `degraded` means requests that need a
   * background job (sending mail, signalling the worker) will fail until the queue
   * is back.
   */
  @Public()
  @Contract(ROUTES.health)
  @Get()
  async health(): Promise<{ status: 'ok' | 'degraded'; db: 'ok'; queue: 'ok' | 'down' }> {
    await this.prisma.$queryRaw`SELECT 1`;
    const queue = this.queue.healthy ? 'ok' : 'down';
    return { status: queue === 'ok' ? 'ok' : 'degraded', db: 'ok', queue };
  }
}
