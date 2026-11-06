import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService, ORGANIZATION_RESOURCE } from '../access/access.service';
import { ACTIONS } from '../access/actions';
import { AdminPage, PUBSUB_PORT, PubSubPort } from './pubsub.port';
import { AdminPresenceDto } from './admin-presence.dto';

/**
 * What it takes to view each admin page: the admin area itself (`config:update`) plus,
 * for the pages whose data has its own read gate, that gate. Presence goes only to
 * people who pass, so nobody learns of edits to data they couldn't see.
 */
const PAGE_GATES: Record<AdminPage, string[]> = {
  roles: [ACTIONS.configUpdate.action],
  divisions: [ACTIONS.configUpdate.action],
  teams: [ACTIONS.configUpdate.action],
  users: [ACTIONS.configUpdate.action],
  settings: [ACTIONS.configUpdate.action],
  permissions: [ACTIONS.configUpdate.action, ACTIONS.grantCreate.action],
  integrations: [ACTIONS.configUpdate.action, ACTIONS.integrationCreate.action],
};

/** Relays an admin's editing state on an admin page to the others who can see it. */
@Injectable()
export class AdminPresenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    @Inject(PUBSUB_PORT) private readonly pubsub: PubSubPort,
  ) {}

  async announce(actorUserId: string, dto: AdminPresenceDto): Promise<void> {
    const recipients = this.pubsub.subscribedUserIds().filter((id) => id !== actorUserId);
    if (recipients.length === 0) return;
    const actor = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: actorUserId },
      select: { displayName: true },
    });
    const gates = PAGE_GATES[dto.page];
    const at = new Date().toISOString();
    for (const userId of recipients) {
      const allowed = await this.access.decideMany(
        userId,
        gates.map((action) => ({ action, resource: ORGANIZATION_RESOURCE })),
      );
      if (allowed.every(Boolean)) {
        this.pubsub.publish(userId, {
          type: 'admin-presence',
          page: dto.page,
          userId: actorUserId,
          displayName: actor.displayName,
          state: dto.state,
          at,
        });
      }
    }
  }
}
