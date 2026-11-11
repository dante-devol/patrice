import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { CommonModule } from './common/common.module';
import { SettingsModule } from './settings/settings.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { PrismaModule } from './prisma/prisma.module';
import { ActivityModule } from './activity/activity.module';
import { UnitDefaultsModule } from './membership/unit-defaults.service';
import { AccessModule } from './access/access.module';
import { QueueModule } from './queue/queue.module';
import { AuthModule } from './auth/auth.module';
import { OAuthModule } from './oauth/oauth.module';
import { InvitationsModule } from './invitations/invitations.module';
import { RolesModule } from './roles/roles.module';
import { DivisionsModule } from './divisions/divisions.module';
import { TeamsModule } from './teams/teams.module';
import { MembershipModule } from './membership/membership.module';
import { UnitRolesModule } from './unit-roles/unit-roles.module';
import { UnitStatsModule } from './unit-stats/unit-stats.module';
import { GrantsModule } from './grants/grants.module';
import { UsersModule } from './users/users.module';
import { RequestTemplatesModule } from './request-templates/request-templates.module';
import { TasksModule } from './tasks/tasks.module';
import { SubmissionsModule } from './submissions/submissions.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { StorageModule } from './storage/storage.module';
import { GcModule } from './gc/gc.module';
import { IntegrationsModule } from './integrations/integrations.module';

const SHARED = [
    ConfigModule,
    CommonModule,
    SettingsModule,
    InfrastructureModule,
    PrismaModule,
    ActivityModule,
    UnitDefaultsModule,
    AccessModule,
    QueueModule,
    AuthModule,
    InvitationsModule,
    OAuthModule,
    RolesModule,
    DivisionsModule,
    TeamsModule,
    MembershipModule,
    UnitRolesModule,
    UnitStatsModule,
    GrantsModule,
    UsersModule,
    RequestTemplatesModule,
    StorageModule,
    MessagesModule,
    NotificationsModule,
    AttachmentsModule,
    TasksModule,
    SubmissionsModule,
    GcModule,
    IntegrationsModule,
];

/**
 * Everything both processes share: configuration, persistence, access, and the
 * feature modules' services. Background work is not here: queue consumers,
 * schedules, email and the Discord Gateway live only in {@link WorkerModule}.
 */
@Module({ imports: SHARED, exports: SHARED })
export class CoreModule {}
