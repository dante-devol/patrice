import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';

@Module({
  controllers: [UsersController, ConfigController],
  providers: [UsersService, ConfigService],
  exports: [UsersService, ConfigService],
})
export class UsersModule {}
