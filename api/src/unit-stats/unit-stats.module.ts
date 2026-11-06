import { Module } from '@nestjs/common';
import { UnitStatsController } from './unit-stats.controller';
import { UnitStatsService } from './unit-stats.service';

@Module({
  controllers: [UnitStatsController],
  providers: [UnitStatsService],
})
export class UnitStatsModule {}
