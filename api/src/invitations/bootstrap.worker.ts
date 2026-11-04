import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';

/** Worker: opens (or closes) bootstrap mode once per worker start. */
@Injectable()
export class BootstrapWorker implements OnApplicationBootstrap {
  constructor(private readonly bootstrap: BootstrapService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.bootstrap.openBootstrap();
  }
}
