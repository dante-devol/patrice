import { Injectable, Logger } from '@nestjs/common';
import { ActivitySource, LifecycleState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError } from '../common/errors';
import { SyncService } from './sync/sync.service';
import { AdministrabilityService } from '../access/administrability.service';
import type { ExternalProfile } from '../auth/providers/login-provider';

/**
 * Sync links (`external_identity`): which Discord account is which member, per
 * connection. Patrice creates them wherever it knows a member's Discord id — when they
 * register through Discord, when they connect Discord to their account, and for every
 * such member when a connection is added (problems D22).
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
    private readonly admin: AdministrabilityService,
  ) {}

  /**
   * Create the user's integration link on every active Discord connection, after
   * their Discord sign-in identity has been attached (link and registration alike).
   * Idempotent (a re-link refreshes handle and avatar); a reconcile is enqueued so
   * mapped roles populate promptly.
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
      await this.upsertLink(conn.id, userId, profile.subject, {
        handle: profile.displayName ?? profile.username,
        avatar: profile.avatar,
      });
      await this.enqueueSync(conn.id);
    }
  }

  /**
   * Link every member whose Discord id Patrice already knows (from Discord sign-in)
   * to a connection — run when a connection is added or reconnected (problems D22).
   * A Discord id another member already holds on it is skipped.
   */
  async linkKnownMembers(connectionId: string): Promise<number> {
    const identities = await this.prisma.userIdentity.findMany({
      where: { provider: 'discord', providerSubject: { not: null }, user: { lifecycleState: LifecycleState.active } },
      select: { userId: true, providerSubject: true },
    });
    let linked = 0;
    for (const id of identities) {
      const taken = await this.prisma.externalIdentity.findUnique({
        where: { connectionId_externalUserId: { connectionId, externalUserId: id.providerSubject! } },
        select: { userId: true },
      });
      if (taken && taken.userId !== id.userId) continue;
      await this.upsertLink(connectionId, id.userId, id.providerSubject!, {});
      linked++;
    }
    return linked;
  }

  private async upsertLink(
    connectionId: string,
    userId: string,
    externalUserId: string,
    profile: { handle?: string | null; avatar?: string | null },
  ): Promise<void> {
    const existing = await this.prisma.externalIdentity.findUnique({
      where: { userId_connectionId: { userId, connectionId } },
      select: { id: true },
    });
    const identity = await this.prisma.externalIdentity.upsert({
      where: { userId_connectionId: { userId, connectionId } },
      create: {
        userId,
        connectionId,
        externalUserId,
        externalHandle: profile.handle ?? null,
        externalAvatarHash: profile.avatar ?? null,
      },
      update: {
        ...(profile.handle !== undefined ? { externalHandle: profile.handle } : {}),
        ...(profile.avatar !== undefined ? { externalAvatarHash: profile.avatar } : {}),
      },
      select: { id: true },
    });
    if (!existing) {
      await this.activity.logActivity({
        actorUserId: userId,
        subjectType: 'external_identity',
        subjectId: identity.id,
        verb: 'external_identity.linked',
        payload: { connectionId, userId, externalIdentityId: identity.id },
      });
    }
  }

  /** A queue hiccup must not fail the user's link; the reconcile floor catches up. */
  private async enqueueSync(connectionId: string): Promise<void> {
    await this.sync.enqueue(connectionId).catch((err) => {
      this.logger.warn(`reconcile enqueue after link failed for ${connectionId}: ${(err as Error).message}`);
    });
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
      // reconciler can't (the link is gone), so we do it here. One transaction per
      // link, under the admin floor: unlinking can't strip the last admin.
      await this.admin.withAdminFloor(
        userId,
        { type: 'user', id: userId, path: 'discord.unlink' },
        async (tx) => {
          const integrationRoles = await tx.userRole.findMany({
            where: { userId, source: 'integration', sourceConnectionId: link.connectionId },
            select: { roleId: true },
          });
          for (const ur of integrationRoles) {
            await tx.userRole.delete({
              where: { userId_roleId: { userId, roleId: ur.roleId } },
            });
            await this.activity.logActivity({
              tx,
              actorUserId: userId,
              subjectType: 'user_role',
              subjectId: userId,
              verb: 'integration.removed',
              payload: { connectionId: link.connectionId, userId, roleId: ur.roleId },
              source: ActivitySource.integration,
              sourceConnectionId: link.connectionId,
            });
          }

          await tx.syncBaseline.deleteMany({
            where: { connectionId: link.connectionId, externalUserId: link.externalUserId },
          });
          await tx.externalIdentity.delete({ where: { id: link.id } });
          await this.activity.logActivity({
            tx,
            actorUserId: userId,
            subjectType: 'external_identity',
            subjectId: link.id,
            verb: 'external_identity.unlinked',
            payload: { connectionId: link.connectionId, userId, externalIdentityId: link.id },
          });
        },
      );
    }

    return links.length > 0;
  }
}
