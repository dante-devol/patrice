import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ConflictError } from '../common/errors';
import { EFFECTIVE_ADMIN_ACTIONS } from './actions';
import { AccessService, ORGANIZATION_RESOURCE } from './access.service';

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
 * The **effective-admin** predicate: the single source for bootstrap ("no effective
 * admin" reopens setup) and the administrability invariant.
 *
 * An effective admin is an *active* user whom Cedar permits every one of
 * EFFECTIVE_ADMIN_ACTIONS org-wide. The answer is a real Cedar decision over the
 * projected policy set, so `forbid` grants count, and inside a transaction it sees
 * the uncommitted change being made.
 */
@Injectable()
export class AdministrabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly access: AccessService,
  ) {}

  /** The ids of every active effective admin (the cohort for admin alerts too). */
  async effectiveAdminIds(tx?: Prisma.TransactionClient): Promise<string[]> {
    const db = tx ?? this.prisma;
    // Candidates: active users holding an active role with any permit grant on a
    // governance action. Cedar then decides, forbids included.
    const candidates = await db.appUser.findMany({
      where: {
        lifecycleState: 'active',
        userRoles: {
          some: {
            role: {
              lifecycleState: 'active',
              grants: {
                some: { effect: 'permit', action: { in: [...EFFECTIVE_ADMIN_ACTIONS] } },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    const policiesText = await this.access.projectPolicies(db);
    const admins: string[] = [];
    for (const { id } of candidates) {
      const principal = await this.access.buildPrincipal(id, db, policiesText);
      const all = EFFECTIVE_ADMIN_ACTIONS.every((action) =>
        this.access.evaluate(policiesText, principal, action, ORGANIZATION_RESOURCE),
      );
      if (all) admins.push(id);
    }
    return admins;
  }

  async effectiveAdminCount(tx?: Prisma.TransactionClient): Promise<number> {
    return (await this.effectiveAdminIds(tx)).length;
  }

  /** Whether at least one effective admin exists. */
  async effectiveAdminExists(tx?: Prisma.TransactionClient): Promise<boolean> {
    return (await this.effectiveAdminCount(tx)) > 0;
  }

  /**
   * Call **inside a guarded transaction, after the candidate mutation** has been
   * applied to `tx`: if the post-write Effective Admin count is zero, throw
   * `LastAdminError` to roll the whole transaction back. The administrability
   * invariant in predict-by-applying-then-checking form (docs/slices/02).
   */
  async assertFloorWithinTx(
    path: string,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const count = await this.effectiveAdminCount(tx);
    if (count === 0) throw new LastAdminError(path, subjectId);
  }

  /**
   * Run `mutate` under the admin-floor guard. On a `LastAdminError` rollback, write
   * an immutable `last_admin_refused` activity row (committed separately, since the
   * guarded transaction is gone) and raise `409 LAST_ADMIN`.
   */
  async withAdminFloor<T>(
    actorUserId: string | null,
    subject: { type: string; id: string; path: string },
    mutate: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await mutate(tx);
        await this.assertFloorWithinTx(subject.path, subject.id, tx);
        return result;
      });
    } catch (e) {
      if (e instanceof LastAdminError) {
        await this.activity.logActivity({
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
