import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError } from '../common/errors';
import { SyncService } from './sync/sync.service';
import type { ExternalProfile } from '../auth/providers/login-provider';

/**
 * The **user-driven** Discord account connection (distinct from the admin-driven
 * role mapping). One consent establishes, for the acting user:
 *   1. a Discord sign-in method (`user_identity[discord]`) — enables login, and
 *   2. an integration link (`external_identity`) per active Discord connection —
 *      enables role sync.
 * After linking, a reconcile is enqueued so the user's mapped Discord roles flow
 * into Patrice immediately (the reconciler's warm-baseline path grants on a fresh
 * link — it never strips, since the new edge reads as "Discord diverged").
 */
@Injectable()
export class DiscordLinkService {
  private readonly logger = new Logger(DiscordLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly sync: SyncService,
  ) {}

  /**
   * Create the user's integration link on every active Discord connection, after
   * their Discord sign-in identity has been attached. Idempotent (a re-link refreshes
   * handle and avatar). Reconcile is enqueued so mapped roles populate promptly.
   */
  async linkConnections(userId: string, profile: ExternalProfile): Promise<void> {
    const connections = await this.prisma.integrationConnection.findMany({
      where: { provider: 'discord', lifecycleState: LifecycleState.active },
      select: { id: true },
    });

    for (const conn of connections) {
      const clash = await this.prisma.externalIdentity.findUnique({
        where: {
          connectionId_externalUserId: { connectionId: conn.id, externalUserId: profile.subject },
        },
        select: { userId: true },
      });
      if (clash && clash.userId !== userId) {
        // Another Patrice user already claims this Discord account on this guild.
        throw new ConflictError(
          'DISCORD_ALREADY_LINKED',
          'That Discord account is already linked to another Patrice account on this server',
        );
      }

      const identity = await this.prisma.externalIdentity.upsert({
        where: { userId_connectionId: { userId, connectionId: conn.id } },
        create: {
          userId,
          connectionId: conn.id,
          externalUserId: profile.subject,
          externalHandle: profile.displayName ?? profile.username,
          externalAvatarHash: profile.avatar,
        },
        update: {
          externalHandle: profile.displayName ?? profile.username,
          externalAvatarHash: profile.avatar,
        },
        select: { id: true },
      });

      await this.activity.logActivity({
        actorUserId: userId,
        subjectType: 'external_identity',
        subjectId: identity.id,
        verb: 'external_identity.linked',
        payload: { connectionId: conn.id, userId, externalIdentityId: identity.id },
      });

      // Fire-and-forget — a queue hiccup must not fail the user's link.
      this.sync.enqueue(conn.id).catch((err) => {
        this.logger.warn(`reconcile enqueue after link failed for ${conn.id}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Remove the user's integration links on every Discord connection, with the
   * integration-sourced roles and baseline rows they carried. Runs after the Discord
   * sign-in identity is detached (or when only links remain).
   * Returns whether there was anything to remove.
   */
  async removeLinks(userId: string): Promise<boolean> {
    const links = await this.prisma.externalIdentity.findMany({
      where: { userId, connection: { provider: 'discord' } },
      select: { id: true, connectionId: true, externalUserId: true },
    });

    for (const link of links) {
      // Revoke integration-sourced roles this connection granted the user; the
      // reconciler can't (the link is gone), so we do it here. Read-fresh actor
      // roles mean this takes effect on the next request without a cache bump.
      const integrationRoles = await this.prisma.userRole.findMany({
        where: { userId, source: 'integration', sourceConnectionId: link.connectionId },
        select: { roleId: true },
      });
      for (const ur of integrationRoles) {
        await this.prisma.userRole.delete({
          where: { userId_roleId: { userId, roleId: ur.roleId } },
        });
        await this.activity.logActivity({
          actorUserId: userId,
          subjectType: 'user_role',
          subjectId: userId,
          verb: 'integration.removed',
          payload: { connectionId: link.connectionId, userId, roleId: ur.roleId },
          source: ActivitySource.integration,
          sourceConnectionId: link.connectionId,
        });
      }

      await this.prisma.syncBaseline.deleteMany({
        where: { connectionId: link.connectionId, externalUserId: link.externalUserId },
      });
      await this.prisma.externalIdentity.delete({ where: { id: link.id } });
      await this.activity.logActivity({
        actorUserId: userId,
        subjectType: 'external_identity',
        subjectId: link.id,
        verb: 'external_identity.unlinked',
        payload: { connectionId: link.connectionId, userId, externalIdentityId: link.id },
      });
    }

    return links.length > 0;
  }
}
