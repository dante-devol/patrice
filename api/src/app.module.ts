import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
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
import { UsersModule } from './users/users.module';
import { QuestionnairesModule } from './questionnaires/questionnaires.module';
import { TasksModule } from './tasks/tasks.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { StorageModule } from './storage/storage.module';
import { GcModule } from './gc/gc.module';
import { HealthController } from './health/health.controller';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    // App-wide request ceiling (in-memory store — fits the single-instance v1 topology;
    // a multi-instance deployment would swap in a shared store). Credential/token routes
    // tighten this further with @Throttle (see auth/invitations controllers). Skipped
    // under NODE_ENV=test so the e2e suite's repeated logins/redemptions don't 429.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ConfigModule,
    CommonModule,
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
    UsersModule,
    QuestionnairesModule,
    StorageModule,
    MessagesModule,
    NotificationsModule,
    AttachmentsModule,
    TasksModule,
    SubmissionsModule,
    GcModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: throttle before any work, then SessionGuard resolves identity
    // (+ CSRF), then the AuthorizeGuard enforces the declared Cedar action.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: AuthorizeGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
