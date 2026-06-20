import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { ActivityModule } from './activity/activity.module';
import { AccessModule } from './access/access.module';
import { AuthorizeGuard } from './access/authorize.guard';
import { QueueModule } from './queue/queue.module';
import { EmailModule } from './email/email.module';
import { AuthModule } from './auth/auth.module';
import { SessionGuard } from './auth/session.guard';
import { InvitationsModule } from './invitations/invitations.module';
import { RolesModule } from './roles/roles.module';
import { DivisionsModule } from './divisions/divisions.module';
import { TeamsModule } from './teams/teams.module';
import { GrantsModule } from './grants/grants.module';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ActivityModule,
    AccessModule,
    QueueModule,
    EmailModule,
    AuthModule,
    InvitationsModule,
    RolesModule,
    DivisionsModule,
    TeamsModule,
    GrantsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: SessionGuard resolves identity (+ CSRF) first, then the
    // AuthorizeGuard enforces the declared Cedar action.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: AuthorizeGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
