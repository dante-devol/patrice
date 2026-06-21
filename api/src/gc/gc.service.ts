import { Inject, Injectable, Logger } from '@nestjs/common';
import { ActivitySource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { GraceService } from '../common/grace.service';
import { STORAGE_PORT, StoragePort } from '../storage/storage.port';

/** What a sweep would collect (dry-run) or did collect (real run). */
export interface GcReport {
  tasks: string[];
  divisions: string[];
  teams: string[];
  roles: string[];
  /** Entities whose delete was attempted but left in place by a live reference. */
  blocked: { entityType: string; entityId: string }[];
  /** Orphaned blobs reconciled away (0 on dry-run). */
  orphanedBlobs: number;
}

/** Postgres foreign-key (RESTRICT) violation — the GC backstop signal. */
function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

/**
 * The lazy GC sweep (Slice 7.3). For each entity retired **past the Grace Period**,
 * it checks the static referrer set (`EXISTS` over known FKs) and permanently deletes
 * those with no live references — task aggregates as a unit, roles/divisions/teams
 * individually. `ON DELETE RESTRICT` is the DB backstop: a still-referenced row's
 * delete simply fails, is logged as a `gc.blocked` alert, and is retried next sweep.
 * A reconciliation pass removes orphaned blobs the store leaked on a crash mid-delete.
 *
 * Runs as a pg-boss job (`singletonKey: 'gc-sweep'`, {@link GcModule}); the admin
 * endpoints call {@link sweep}/{@link dryRun} directly so it is testable without a queue.
 */
@Injectable()
export class GcService {
  private readonly logger = new Logger(GcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly grace: GraceService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** The singleton org id + the past-grace cutoff `Date` for collectability. */
  private async sweepContext(): Promise<{ orgId: string; cutoff: Date }> {
    const org = await this.prisma.organization.findFirstOrThrow({
      select: { id: true, settings: true },
    });
    const graceMs = GraceService.windowMsFromSettings(org.settings);
    return { orgId: org.id, cutoff: new Date(Date.now() - graceMs) };
  }

  /** Retired-past-grace candidates of each lifecycle type, with referrer pre-checks. */
  private async collectable(
    orgId: string,
    cutoff: Date,
  ): Promise<{ tasks: string[]; divisions: string[]; teams: string[]; roles: string[] }> {
    const where = {
      organizationId: orgId,
      lifecycleState: 'retired' as const,
      retiredAt: { lt: cutoff },
    };

    // Tasks: a task aggregate has no *external* referrers (only its own children +
    // the FK-less activity log), so every past-grace retired task is collectable.
    const tasks = (
      await this.prisma.task.findMany({ where, select: { id: true } })
    ).map((t) => t.id);

    // Divisions: collectable once no task references them and their inherent role is
    // itself unreferenced (no membership / grant).
    const divisions: string[] = [];
    for (const d of await this.prisma.division.findMany({
      where,
      select: { id: true, inherentRole: { select: { id: true } } },
    })) {
      if (await this.divisionCollectable(d.id, d.inherentRole?.id)) divisions.push(d.id);
    }

    const teams: string[] = [];
    for (const t of await this.prisma.team.findMany({
      where,
      select: { id: true, inherentRole: { select: { id: true } } },
    })) {
      if (await this.teamCollectable(t.id, t.inherentRole?.id)) teams.push(t.id);
    }

    // Roles: only **standalone** roles GC individually; inherent roles are collected
    // with their division/team. Collectable once no membership / grant references it.
    const roles: string[] = [];
    for (const r of await this.prisma.role.findMany({
      where: { ...where, kind: 'standalone' },
      select: { id: true },
    })) {
      if (await this.roleUnreferenced(r.id)) roles.push(r.id);
    }

    return { tasks, divisions, teams, roles };
  }

  private async roleUnreferenced(roleId: string): Promise<boolean> {
    const [memberships, grants] = await Promise.all([
      this.prisma.userRole.count({ where: { roleId } }),
      this.prisma.grant.count({ where: { roleId } }),
    ]);
    return memberships === 0 && grants === 0;
  }

  private async divisionCollectable(
    divisionId: string,
    inherentRoleId: string | undefined,
  ): Promise<boolean> {
    const tasks = await this.prisma.task.count({ where: { divisionId } });
    if (tasks > 0) return false;
    return inherentRoleId ? this.roleUnreferenced(inherentRoleId) : true;
  }

  private async teamCollectable(
    teamId: string,
    inherentRoleId: string | undefined,
  ): Promise<boolean> {
    const tasks = await this.prisma.task.count({ where: { teamId } });
    if (tasks > 0) return false;
    return inherentRoleId ? this.roleUnreferenced(inherentRoleId) : true;
  }

  /** Report what a sweep would collect — no deletes, no blob removal. */
  async dryRun(): Promise<GcReport> {
    const { orgId, cutoff } = await this.sweepContext();
    const c = await this.collectable(orgId, cutoff);
    return { ...c, blocked: [], orphanedBlobs: 0 };
  }

  /** Run the sweep: delete collectable entities, remove blobs, reconcile orphans. */
  async sweep(): Promise<GcReport> {
    const { orgId, cutoff } = await this.sweepContext();
    const c = await this.collectable(orgId, cutoff);
    const report: GcReport = {
      tasks: [],
      divisions: [],
      teams: [],
      roles: [],
      blocked: [],
      orphanedBlobs: 0,
    };

    // Tasks first: deleting a retired task frees its references to retired
    // divisions/teams, so those can collect in this same sweep.
    for (const taskId of c.tasks) {
      const blobKeys = await this.deleteTaskAggregate(orgId, taskId, report);
      if (blobKeys) {
        report.tasks.push(taskId);
        for (const key of blobKeys) {
          await this.storage.delete(key).catch((e) =>
            this.logger.error(`Blob delete failed for ${key}: ${(e as Error).message}`),
          );
        }
      }
    }

    // Recompute division/team/role collectability — the task deletes above may have
    // newly freed some referrers.
    const fresh = await this.collectable(orgId, cutoff);
    for (const divisionId of fresh.divisions) {
      if (await this.deleteDivision(orgId, divisionId, report)) report.divisions.push(divisionId);
    }
    for (const teamId of fresh.teams) {
      if (await this.deleteTeam(orgId, teamId, report)) report.teams.push(teamId);
    }
    for (const roleId of fresh.roles) {
      if (await this.deleteStandaloneRole(orgId, roleId, report)) report.roles.push(roleId);
    }

    report.orphanedBlobs = await this.reconcileOrphanedBlobs(orgId);
    return report;
  }

  /**
   * Delete a task and its whole aggregate as a unit (messages, submissions, answers,
   * claimant slots, attachments, the task-owned questionnaire). Self-referential FKs
   * (reply→parent, resubmission→prior) are nulled first so a single `deleteMany` can't
   * trip RESTRICT mid-statement. Returns the deleted attachments' storage keys (for
   * post-commit blob removal), or `null` if a RESTRICT backstop blocked the delete.
   */
  private async deleteTaskAggregate(
    orgId: string,
    taskId: string,
    report: GcReport,
  ): Promise<string[] | null> {
    try {
      const blobKeys = await this.prisma.$transaction(async (tx) => {
        const attachments = await tx.attachment.findMany({
          where: {
            OR: [{ message: { taskId } }, { answer: { submission: { taskId } } }],
          },
          select: { id: true, storageKey: true },
        });

        // Break self-references so the bulk deletes below are order-independent.
        await tx.message.updateMany({ where: { taskId }, data: { parentMessageId: null } });
        await tx.submission.updateMany({ where: { taskId }, data: { prevSubmissionId: null } });

        await tx.attachment.deleteMany({
          where: { id: { in: attachments.map((a) => a.id) } },
        });
        await tx.message.deleteMany({ where: { taskId } });
        await tx.submission.deleteMany({ where: { taskId } }); // cascades answers
        await tx.taskClaimant.deleteMany({ where: { taskId } });
        await tx.questionnaire.deleteMany({ where: { ownerTaskId: taskId } }); // cascades questions
        await tx.task.delete({ where: { id: taskId } });

        await this.logCollected(tx, orgId, 'task', taskId, 'gc.task_collected', {
          taskId,
        });
        return attachments.map((a) => a.storageKey);
      });
      return blobKeys;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'task', taskId, err, report);
      return null;
    }
  }

  private async deleteDivision(
    orgId: string,
    divisionId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Owned children first (questionnaire + inherent role), then the division —
        // each FK is RESTRICT, so order matters.
        await tx.questionnaire.deleteMany({ where: { ownerDivisionId: divisionId } });
        await tx.role.deleteMany({ where: { divisionId } });
        await tx.division.delete({ where: { id: divisionId } });
        await this.logCollected(tx, orgId, 'division', divisionId, 'gc.division_collected', {
          divisionId,
        });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'division', divisionId, err, report);
      return false;
    }
  }

  private async deleteTeam(
    orgId: string,
    teamId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.deleteMany({ where: { teamId } });
        await tx.team.delete({ where: { id: teamId } });
        await this.logCollected(tx, orgId, 'team', teamId, 'gc.team_collected', { teamId });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'team', teamId, err, report);
      return false;
    }
  }

  private async deleteStandaloneRole(
    orgId: string,
    roleId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.role.delete({ where: { id: roleId } });
        await this.logCollected(tx, orgId, 'role', roleId, 'gc.role_collected', { roleId });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'role', roleId, err, report);
      return false;
    }
  }

  /** Log a `gc.blocked` alert for a RESTRICT backstop hit; rethrow real errors. */
  private handleDeleteFailure(
    orgId: string,
    entityType: string,
    entityId: string,
    err: unknown,
    report: GcReport,
  ): boolean {
    if (!isForeignKeyViolation(err)) {
      this.logger.error(
        `GC delete of ${entityType} ${entityId} errored: ${(err as Error).message}`,
      );
      throw err;
    }
    this.logger.warn(
      `GC RESTRICT backstop: ${entityType} ${entityId} still referenced; left in place.`,
    );
    report.blocked.push({ entityType, entityId });
    // Best-effort alert row (outside the rolled-back tx).
    void this.activity
      .logActivity({
        organizationId: orgId,
        actorUserId: null,
        subjectType: entityType,
        subjectId: entityId,
        verb: 'gc.blocked',
        payload: { entityType, entityId },
        source: ActivitySource.system,
      })
      .catch(() => undefined);
    return true;
  }

  private logCollected(
    tx: Prisma.TransactionClient,
    orgId: string,
    subjectType: string,
    subjectId: string,
    verb: 'gc.task_collected' | 'gc.role_collected' | 'gc.division_collected' | 'gc.team_collected',
    payload: Record<string, string>,
  ): Promise<void> {
    return this.activity.logActivity({
      tx,
      organizationId: orgId,
      actorUserId: null,
      subjectType,
      subjectId,
      verb,
      payload: payload as never,
      source: ActivitySource.system,
    });
  }

  /**
   * Orphaned-blob reconciliation: every key in the store that has no surviving
   * `attachment` row is deleted (a crash between the DB delete and the blob delete
   * would otherwise leak storage). Returns the number of blobs removed.
   */
  async reconcileOrphanedBlobs(orgId: string): Promise<number> {
    const keys = await this.storage.list(`attachments/${orgId}/`);
    if (keys.length === 0) return 0;
    const known = new Set(
      (
        await this.prisma.attachment.findMany({
          where: { storageKey: { in: keys } },
          select: { storageKey: true },
        })
      ).map((a) => a.storageKey),
    );
    const orphans = keys.filter((k) => !known.has(k));
    for (const key of orphans) {
      await this.storage.delete(key).catch((e) =>
        this.logger.error(`Orphan blob delete failed for ${key}: ${(e as Error).message}`),
      );
    }
    if (orphans.length > 0) {
      await this.activity
        .logActivity({
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'organization',
          subjectId: orgId,
          verb: 'gc.blob_reconciled',
          payload: { blobCount: orphans.length },
          source: ActivitySource.system,
        })
        .catch(() => undefined);
    }
    return orphans.length;
  }
}
