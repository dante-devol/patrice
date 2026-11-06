import { Module } from '@nestjs/common';
import { UnitRolesController } from './unit-roles.controller';
import { UnitRolesService } from './unit-roles.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [UnitRolesController],
  providers: [UnitRolesService],
  exports: [UnitRolesService],
})
export class UnitRolesModule {}
