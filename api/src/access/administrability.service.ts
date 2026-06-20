import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError } from '../common/errors';
import { EFFECTIVE_ADMIN_ACTIONS } from './actions';

/**
 * Internal sentinel thrown from inside a guarded transaction when a mutation would
 * empty the Effective Admin set. It rolls the transaction back; the caller catches
 * it and converts it to a `409 LAST_ADMIN` after logging `last_admin_refused`.
 */
export class LastAdminError extends Error {
  constructor(
    readonly path: string,
    readonly subjectId: string,
  ) {
    super('LAST_ADMIN');
  }
}

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

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
        AND g.lifecycle_state = 'active'
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

  /**
   * Call **inside a guarded transaction, after the candidate mutation** has been
   * applied to `tx`: if the post-write Effective Admin count is zero, throw
   * `LastAdminError` to roll the whole transaction back. The administrability
   * invariant in predict-by-applying-then-checking form (docs/slices/02).
   */
  async assertFloorWithinTx(
    organizationId: string,
    path: string,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const count = await this.effectiveAdminCount(organizationId, tx);
    if (count === 0) throw new LastAdminError(path, subjectId);
  }

  /**
   * Run `mutate` under the admin-floor guard. On a `LastAdminError` rollback, write
   * an immutable `last_admin_refused` activity row (committed separately, since the
   * guarded transaction is gone) and raise `409 LAST_ADMIN`.
   */
  async withAdminFloor<T>(
    organizationId: string,
    actorUserId: string,
    subject: { type: string; id: string; path: string },
    mutate: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await mutate(tx);
        await this.assertFloorWithinTx(organizationId, subject.path, subject.id, tx);
        return result;
      });
    } catch (e) {
      if (e instanceof LastAdminError) {
        await this.activity.logActivity({
          organizationId,
          actorUserId,
          subjectType: subject.type,
          subjectId: subject.id,
          verb: 'last_admin_refused',
          payload: { path: e.path, subjectId: e.subjectId },
        });
        throw new ConflictError(
          'LAST_ADMIN',
          'Refused: this would remove the last administrator',
        );
      }
      throw e;
    }
  }
}
