import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, AuthProvider, LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError, UnprocessableError } from '../common/errors';
import { SyncService } from './sync/sync.service';
import type { DiscordOAuthUser } from '../auth/discord-oauth.service';

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

  /** Connect the acting user's Discord account. Idempotent (re-link refreshes handle/avatar). */
  async completeLink(userId: string, discordUser: DiscordOAuthUser): Promise<void> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    if (!user) throw new UnprocessableError('USER_NOT_FOUND', 'User not found');
    const organizationId = user.organizationId;

    // 1. Discord sign-in identity. (provider, subject) is globally unique, so a
    //    Discord account already used by *another* Patrice user is rejected.
    const existingAuth = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: AuthProvider.discord,
          providerSubject: discordUser.id,
        },
      },
      select: { userId: true },
    });
    if (existingAuth && existingAuth.userId !== userId) {
      throw new ConflictError(
        'DISCORD_ALREADY_LINKED',
        'That Discord account is already linked to another Patrice account',
      );
    }
    if (!existingAuth) {
      await this.prisma.userIdentity.create({
        data: {
          userId,
          provider: AuthProvider.discord,
          providerSubject: discordUser.id,
          verifiedAt: new Date(), // OAuth proves control at consent time
        },
      });
      await this.activity.logActivity({
        organizationId,
        actorUserId: userId,
        subjectType: 'user',
        subjectId: userId,
        verb: 'auth.discord_linked',
        payload: { userId },
      });
    }

    // 2. Integration link per active Discord connection (v1: usually one). Reconcile
    //    is enqueued so mapped roles populate without waiting for the floor sweep.
    const connections = await this.prisma.integrationConnection.findMany({
      where: { provider: 'discord', lifecycleState: LifecycleState.active },
      select: { id: true },
    });

    for (const conn of connections) {
      const clash = await this.prisma.externalIdentity.findUnique({
        where: {
          connectionId_externalUserId: { connectionId: conn.id, externalUserId: discordUser.id },
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
          externalUserId: discordUser.id,
          externalHandle: discordUser.globalName ?? discordUser.username,
          externalAvatarHash: discordUser.avatar,
        },
        update: {
          externalHandle: discordUser.globalName ?? discordUser.username,
          externalAvatarHash: discordUser.avatar,
        },
        select: { id: true },
      });

      await this.activity.logActivity({
        organizationId,
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
   * Disconnect the user's Discord account entirely: removes the sign-in method, the
   * integration link(s), any integration-sourced roles, and baseline rows. Refuses
   * if Discord is the user's *only* sign-in method (don't lock them out).
   */
  async unlink(userId: string): Promise<void> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: {
        organizationId: true,
        identities: { select: { id: true, provider: true } },
      },
    });
    if (!user) throw new UnprocessableError('USER_NOT_FOUND', 'User not found');

    const discordIdentity = user.identities.find((i) => i.provider === AuthProvider.discord);
    const links = await this.prisma.externalIdentity.findMany({
      where: { userId, connection: { provider: 'discord' } },
      select: { id: true, connectionId: true, externalUserId: true },
    });

    if (!discordIdentity && links.length === 0) {
      throw new UnprocessableError('NOT_LINKED', 'No Discord account is connected');
    }

    // Last-sign-in-method guard: refuse to strip the only way in.
    if (discordIdentity && user.identities.length === 1) {
      throw new ConflictError(
        'LAST_AUTH_METHOD',
        'Add another sign-in method before disconnecting Discord — it is your only way to log in',
      );
    }

    const organizationId = user.organizationId;

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
          organizationId,
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
        organizationId,
        actorUserId: userId,
        subjectType: 'external_identity',
        subjectId: link.id,
        verb: 'external_identity.unlinked',
        payload: { connectionId: link.connectionId, userId, externalIdentityId: link.id },
      });
    }

    if (discordIdentity) {
      await this.prisma.userIdentity.delete({ where: { id: discordIdentity.id } });
      await this.activity.logActivity({
        organizationId,
        actorUserId: userId,
        subjectType: 'user',
        subjectId: userId,
        verb: 'auth.discord_unlinked',
        payload: { userId },
      });
    }
  }
}
