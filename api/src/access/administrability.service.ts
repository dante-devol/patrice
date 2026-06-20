import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EFFECTIVE_ADMIN_ACTIONS } from './actions';

/**
 * The **effective-admin** predicate — the single source for both Slice 1's
 * bootstrap "no effective admin" trigger and Slice 2/7's administrability
 * invariant (docs/slices/00-overview.md).
 *
 * Effective admin = an *active* user holding a `permit` grant for one of
 * EFFECTIVE_ADMIN_ACTIONS at `scope_kind='global'`. Scoped grants do not count.
 */
@Injectable()
export class AdministrabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Count distinct active users who are effective admins. */
  async effectiveAdminCount(
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db = tx ?? this.prisma;
    const rows = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(DISTINCT u.id) AS count
      FROM app_user u
      JOIN user_role ur ON ur.user_id = u.id
      JOIN role r ON r.id = ur.role_id
      JOIN "grant" g ON g.role_id = r.id
      WHERE u.organization_id = ${organizationId}::uuid
        AND u.lifecycle_state = 'active'
        AND r.lifecycle_state = 'active'
        AND g.effect = 'permit'
        AND g.scope_kind = 'global'
        AND g.action = ANY(${EFFECTIVE_ADMIN_ACTIONS})
    `;
    return Number(rows[0]?.count ?? 0n);
  }

  /** Whether at least one effective admin exists. */
  async effectiveAdminExists(
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return (await this.effectiveAdminCount(organizationId, tx)) > 0;
  }
}
