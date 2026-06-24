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
  /** History-bearing users scrubbed in place to a tombstone (id + display_name kept). */
  usersScrubbed: string[];
  /** History-less users deleted outright. */
  usersDeleted: string[];
  /** Retired-past-grace integration connections collected. */
  integrationConnections: string[];
  /** Entities whose delete was attempted but left in place by a live reference. */
  blocked: { entityType: string; entityId: string }[];
  /** Orphaned blobs reconciled away (0 on dry-run). */
  orphanedBlobs: number;
}

/** A fresh, empty report. */
function emptyReport(): GcReport {
  return {
    tasks: [],
    divisions: [],
    teams: [],
    roles: [],
    usersScrubbed: [],
    usersDeleted: [],
    integrationConnections: [],
    blocked: [],
    orphanedBlobs: 0,
  };
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

  /** Retired-past-grace integration connections with no surviving external_identity or group mappings. */
  private async collectableConnections(orgId: string, cutoff: Date): Promise<string[]> {
    const candidates = await this.prisma.integrationConnection.findMany({
      where: { organizationId: orgId, lifecycleState: 'retired', retiredAt: { lt: cutoff } },
      select: { id: true },
    });
    const result: string[] = [];
    for (const c of candidates) {
      const [ids, mappings] = await Promise.all([
        this.prisma.externalIdentity.count({ where: { connectionId: c.id } }),
        this.prisma.externalGroupMapping.count({ where: { connectionId: c.id } }),
      ]);
      if (ids === 0 && mappings === 0) result.push(c.id);
    }
    return result;
  }

  private async roleUnreferenced(roleId: string): Promise<boolean> {
    const [memberships, grants, mappings] = await Promise.all([
      this.prisma.userRole.count({ where: { roleId } }),
      this.prisma.grant.count({ where: { roleId } }),
      this.prisma.externalGroupMapping.count({ where: { roleId } }),
    ]);
    return memberships === 0 && grants === 0 && mappings === 0;
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

  /** Retired-past-grace users, split by whether they bear authored history. */
  private async collectableUsers(
    orgId: string,
    cutoff: Date,
  ): Promise<{ scrub: string[]; delete: string[] }> {
    const users = await this.prisma.appUser.findMany({
      where: {
        organizationId: orgId,
        lifecycleState: 'retired',
        retiredAt: { lt: cutoff },
      },
      select: { id: true },
    });
    const scrub: string[] = [];
    const del: string[] = [];
    for (const u of users) {
      (await this.userHasHistory(u.id) ? scrub : del).push(u.id);
    }
    return { scrub, delete: del };
  }

  /** Whether a user authored content that must outlive them (→ scrub, not delete). */
  private async userHasHistory(userId: string): Promise<boolean> {
    const [messages, submissions, tasks, attachments, claims] = await Promise.all([
      this.prisma.message.count({ where: { senderUserId: userId } }),
      this.prisma.submission.count({ where: { claimantUserId: userId } }),
      this.prisma.task.count({ where: { requesterUserId: userId } }),
      this.prisma.attachment.count({ where: { uploaderUserId: userId } }),
      this.prisma.taskClaimant.count({ where: { userId } }),
    ]);
    return messages + submissions + tasks + attachments + claims > 0;
  }

  /** Report what a sweep would collect — no deletes, no blob removal. */
  async dryRun(): Promise<GcReport> {
    const { orgId, cutoff } = await this.sweepContext();
    const c = await this.collectable(orgId, cutoff);
    const u = await this.collectableUsers(orgId, cutoff);
    const integrationConnections = await this.collectableConnections(orgId, cutoff);
    return {
      ...emptyReport(),
      ...c,
      usersScrubbed: u.scrub,
      usersDeleted: u.delete,
      integrationConnections,
    };
  }

  /** Run the sweep: delete collectable entities, remove blobs, reconcile orphans. */
  async sweep(): Promise<GcReport> {
    const { orgId, cutoff } = await this.sweepContext();
    const c = await this.collectable(orgId, cutoff);
    const report = emptyReport();

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

    // Users last — the task deletes above may have removed the last claimant/message
    // that kept a user history-bearing, so a re-checked history-less user can now
    // fully delete instead of scrub.
    const freshUsers = await this.collectableUsers(orgId, cutoff);
    for (const userId of freshUsers.scrub) {
      if (await this.scrubUser(orgId, userId, report)) report.usersScrubbed.push(userId);
    }
    for (const userId of freshUsers.delete) {
      if (await this.deleteUser(orgId, userId, report)) report.usersDeleted.push(userId);
    }

    // Collect retired-past-grace integration connections (after user GC, which
    // may have freed the last external_identity reference).
    const freshConnections = await this.collectableConnections(orgId, cutoff);
    for (const connectionId of freshConnections) {
      if (await this.deleteIntegrationConnection(orgId, connectionId, report)) {
        report.integrationConnections.push(connectionId);
      }
    }

    report.orphanedBlobs = await this.reconcileOrphanedBlobs(orgId);
    return report;
  }

  private async deleteIntegrationConnection(
    orgId: string,
    connectionId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.integrationConnection.delete({ where: { id: connectionId } });
        await this.activity.logActivity({
          tx,
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'integration_connection',
          subjectId: connectionId,
          verb: 'gc.integration_connection_collected',
          payload: { connectionId },
          source: ActivitySource.system,
        });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'integration_connection', connectionId, err, report);
      return false;
    }
  }

  /**
   * Scrub-in-Place (api/CONTEXT.md): a history-bearing retired user is reduced to a
   * tombstone — `id` + `display_name` kept (so every FK stays valid), `email`/PII
   * nulled, satellites purged (`user_identity`/`session`/`auth_token`/`notification`),
   * `user_role` stripped. Plus the cross-slice consequences: auto-revoke invitations
   * the user *issued* and null `invitation.email` for invites they *received*.
   */
  private async scrubUser(
    orgId: string,
    userId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.revokeIssuedInvitations(tx, orgId, userId);
        await this.nullReceivedInvitationEmails(tx, userId);
        await this.purgeUserSatellites(tx, userId);
        await tx.appUser.update({
          where: { id: userId },
          data: { email: null, version: { increment: 1 } },
        });
        await this.activity.logActivity({
          tx,
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'user',
          subjectId: userId,
          verb: 'gc.user_scrubbed',
          payload: { userId },
          source: ActivitySource.system,
        });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'user', userId, err, report);
      return false;
    }
  }

  /** Full delete of a history-less retired user (no authored content to preserve). */
  private async deleteUser(
    orgId: string,
    userId: string,
    report: GcReport,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.revokeIssuedInvitations(tx, orgId, userId);
        await this.nullReceivedInvitationEmails(tx, userId);
        await tx.invitationUse.deleteMany({ where: { createdUserId: userId } });
        await this.purgeUserSatellites(tx, userId);
        await tx.appUser.delete({ where: { id: userId } });
        await this.activity.logActivity({
          tx,
          organizationId: orgId,
          actorUserId: null,
          subjectType: 'user',
          subjectId: userId,
          verb: 'gc.user_collected',
          payload: { userId },
          source: ActivitySource.system,
        });
      });
      return true;
    } catch (err) {
      this.handleDeleteFailure(orgId, 'user', userId, err, report);
      return false;
    }
  }

  /** Delete the purgeable per-user satellites (identities, sessions, tokens, etc.). */
  private async purgeUserSatellites(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    await tx.userIdentity.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.authToken.deleteMany({ where: { userId } });
    await tx.notification.deleteMany({ where: { recipientUserId: userId } });
    await tx.userRole.deleteMany({ where: { userId } });
    // Slice 8: purge integration account links (external_identity rows name user as PII).
    await tx.externalIdentity.deleteMany({ where: { userId } });
  }

  /**
   * Auto-revoke every still-pending invitation the user *issued* (one `activity` row
   * per invite, system-actored). Bootstrap invites (`created_by IS NULL`) are immune.
   */
  private async revokeIssuedInvitations(
    tx: Prisma.TransactionClient,
    orgId: string,
    userId: string,
  ): Promise<void> {
    const issued = await tx.invitation.findMany({
      where: { createdBy: userId, revokedAt: null },
      select: { id: true },
    });
    if (issued.length === 0) return;
    await tx.invitation.updateMany({
      where: { createdBy: userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    for (const inv of issued) {
      await this.activity.logActivity({
        tx,
        organizationId: orgId,
        actorUserId: null,
        subjectType: 'invitation',
        subjectId: inv.id,
        verb: 'invite.auto_revoked_on_issuer_retired',
        payload: { invitationId: inv.id, issuerUserId: userId },
        source: ActivitySource.system,
      });
    }
  }

  /** Null `invitation.email` for every invite this user *received* (via its use). */
  private async nullReceivedInvitationEmails(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const uses = await tx.invitationUse.findMany({
      where: { createdUserId: userId },
      select: { invitationId: true },
    });
    if (uses.length === 0) return;
    await tx.invitation.updateMany({
      where: { id: { in: uses.map((u) => u.invitationId) } },
      data: { email: null },
    });
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
