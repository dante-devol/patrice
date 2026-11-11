import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { ResourceRef } from './access.service';
import { CedarEngine } from './cedar/engine';

type Db = PrismaService | Prisma.TransactionClient;

const ref = (type: string, id: string) => ({ __entity: { type: CedarEngine.qualify(type), id } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds Cedar resources from database rows: the one place that decides which
 * attributes each entity type carries. Lifecycle state is deliberately absent:
 * "is it retired?" is checked by the domain, not by policy.
 */
export class EntityLoader {
  constructor(private readonly db: Db) {}

  private id(raw: string, code: Parameters<typeof notFound>[0], label: string): string {
    if (!UUID.test(raw)) throw notFound(code, label);
    return raw;
  }

  /** A task, with its units, requester, seated claimants and claim restrictions. */
  async task(id: string): Promise<ResourceRef> {
    const task = await this.db.task.findUnique({
      where: { id: this.id(id, 'TASK_NOT_FOUND', 'Task') },
      select: {
        id: true,
        divisionId: true,
        teamId: true,
        requesterUserId: true,
        division: { select: { restrictClaims: true } },
        team: { select: { restrictClaims: true } },
        claimants: { where: { leftAt: null }, select: { userId: true } },
      },
    });
    if (!task) throw notFound('TASK_NOT_FOUND', 'Task');
    return taskRef(task);
  }

  /** A submission's task, carrying the submission's author as `claimant`. */
  async submissionTask(submissionId: string): Promise<ResourceRef> {
    const sub = await this.db.submission.findUnique({
      where: { id: this.id(submissionId, 'SUBMISSION_NOT_FOUND', 'Submission') },
      select: { claimantUserId: true, taskId: true },
    });
    if (!sub) throw notFound('SUBMISSION_NOT_FOUND', 'Submission');
    const task = await this.task(sub.taskId);
    return { ...task, attrs: { ...task.attrs, claimant: ref('User', sub.claimantUserId) } };
  }

  async message(id: string): Promise<ResourceRef> {
    const message = await this.db.message.findUnique({
      where: { id: this.id(id, 'MESSAGE_NOT_FOUND', 'Message') },
      select: { id: true, senderUserId: true, task: { select: { divisionId: true, teamId: true } } },
    });
    if (!message) throw notFound('MESSAGE_NOT_FOUND', 'Message');
    return {
      type: 'Message',
      id: message.id,
      attrs: {
        division: ref('Division', message.task.divisionId),
        ...(message.task.teamId ? { team: ref('Team', message.task.teamId) } : {}),
        ...(message.senderUserId ? { sender: ref('User', message.senderUserId) } : {}),
      },
    };
  }

  private async attachmentRow(id: string) {
    const att = await this.db.attachment.findUnique({
      where: { id: this.id(id, 'ATTACHMENT_NOT_FOUND', 'Attachment') },
      select: {
        id: true,
        uploaderUserId: true,
        message: { select: { taskId: true } },
        answer: { select: { submission: { select: { taskId: true } } } },
      },
    });
    const taskId = att?.message?.taskId ?? att?.answer?.submission.taskId;
    if (!att || !taskId) throw notFound('ATTACHMENT_NOT_FOUND', 'Attachment');
    return { ...att, taskId };
  }

  async attachment(id: string): Promise<ResourceRef> {
    const att = await this.attachmentRow(id);
    const task = await this.task(att.taskId);
    return {
      type: 'Attachment',
      id: att.id,
      attrs: {
        division: task.attrs!.division,
        ...(task.attrs!.team ? { team: task.attrs!.team } : {}),
        uploader: ref('User', att.uploaderUserId),
      },
    };
  }

  /** The task an attachment belongs to (the resource for `attachment:read`). */
  async attachmentTask(id: string): Promise<ResourceRef> {
    return this.task((await this.attachmentRow(id)).taskId);
  }

  async division(id: string): Promise<ResourceRef> {
    const d = await this.db.division.findUnique({
      where: { id: this.id(id, 'DIVISION_NOT_FOUND', 'Division') },
      select: { id: true, restrictClaims: true, allowCustomTemplates: true },
    });
    if (!d) throw notFound('DIVISION_NOT_FOUND', 'Division');
    return divisionRef(d);
  }

  /** The division a library template belongs to. */
  async requestTemplateDivision(id: string): Promise<ResourceRef> {
    const t = await this.db.requestTemplate.findUnique({
      where: { id: this.id(id, 'REQUEST_TEMPLATE_NOT_FOUND', 'Request template') },
      select: { divisionId: true },
    });
    if (!t) throw notFound('REQUEST_TEMPLATE_NOT_FOUND', 'Request template');
    return this.division(t.divisionId);
  }

  async team(id: string): Promise<ResourceRef> {
    const t = await this.db.team.findUnique({
      where: { id: this.id(id, 'TEAM_NOT_FOUND', 'Team') },
      select: TEAM_REF_SELECT,
    });
    if (!t) throw notFound('TEAM_NOT_FOUND', 'Team');
    return teamRefOf(t);
  }

  /** A user; `targetRoleId` adds the role being given or taken (the `role` scope). */
  async user(id: string, targetRoleId?: string): Promise<ResourceRef> {
    const user = await this.db.appUser.findUnique({
      where: { id: this.id(id, 'USER_NOT_FOUND', 'User') },
      select: { id: true },
    });
    if (!user) throw notFound('USER_NOT_FOUND', 'User');
    return {
      type: 'User',
      id: user.id,
      attrs: targetRoleId && UUID.test(targetRoleId) ? { targetRole: ref('Role', targetRoleId) } : {},
    };
  }

  async invitation(id: string): Promise<ResourceRef> {
    const inv = await this.db.invitation.findUnique({
      where: { id: this.id(id, 'INVITE_NOT_FOUND', 'Invitation') },
      select: { id: true },
    });
    if (!inv) throw notFound('INVITE_NOT_FOUND', 'Invitation');
    return { type: 'Invitation', id: inv.id };
  }

  async session(id: string): Promise<ResourceRef> {
    const s = await this.db.session.findUnique({
      where: { id: this.id(id, 'SESSION_NOT_FOUND', 'Session') },
      select: { id: true, userId: true },
    });
    if (!s) throw notFound('SESSION_NOT_FOUND', 'Session');
    return { type: 'Session', id: s.id, attrs: { owner: ref('User', s.userId) } };
  }

  async sessionsOf(userId: string): Promise<ResourceRef> {
    const user = await this.user(userId);
    return { type: 'Session', id: `sessions-of:${user.id}`, attrs: { owner: ref('User', user.id) } };
  }
}

export function taskRef(task: {
  id: string;
  divisionId: string;
  teamId: string | null;
  requesterUserId: string;
  division: { restrictClaims: boolean };
  team: { restrictClaims: boolean } | null;
  claimants: { userId: string }[];
}): ResourceRef {
  return {
    type: 'Task',
    id: task.id,
    attrs: {
      division: ref('Division', task.divisionId),
      ...(task.teamId ? { team: ref('Team', task.teamId) } : {}),
      requester: ref('User', task.requesterUserId),
      claimants: task.claimants.map((c) => ref('User', c.userId)),
      // teamRestrictsClaims is always present (false on a teamless task) so the
      // eligibility clause short-circuits without dereferencing resource.team.
      divisionRestrictsClaims: task.division.restrictClaims,
      teamRestrictsClaims: task.team?.restrictClaims ?? false,
    },
  };
}

/** The select that {@link taskRef} needs, for callers loading tasks in bulk. */
export const TASK_REF_SELECT = {
  id: true,
  divisionId: true,
  teamId: true,
  requesterUserId: true,
  division: { select: { restrictClaims: true } },
  team: { select: { restrictClaims: true } },
  claimants: { where: { leftAt: null }, select: { userId: true } },
} as const;

export function divisionRef(d: { id: string; restrictClaims: boolean; allowCustomTemplates?: boolean }): ResourceRef {
  return {
    type: 'Division',
    id: d.id,
    attrs: {
      division: ref('Division', d.id),
      restrictClaims: d.restrictClaims,
      allowCustomTemplates: d.allowCustomTemplates ?? false,
    },
  };
}

/** The facts a Team entity carries: which divisions it supports, and its claim rule. */
export interface TeamRefInput {
  id: string;
  allDivisions: boolean;
  divisionIds: readonly string[];
  restrictClaims: boolean;
}

/**
 * A team as Cedar sees it. It states facts only: the divisions it lists (none when it
 * supports all of them), `allDivisions`, and `divisionCount` (Cedar has no set size).
 * Whether division authority reaches the team is the policies' call (§2 of
 * docs/plans/multi-division-teams.md): only a team with exactly one division is in
 * that division's reach.
 */
export function teamRef(t: TeamRefInput): ResourceRef {
  const divisionIds = t.allDivisions ? [] : [...t.divisionIds];
  return {
    type: 'Team',
    id: t.id,
    attrs: {
      team: ref('Team', t.id),
      divisions: divisionIds.map((d) => ref('Division', d)),
      allDivisions: t.allDivisions,
      divisionCount: divisionIds.length,
      restrictClaims: t.restrictClaims,
    },
  };
}

/** The select a team row needs for {@link teamRefOf}. */
export const TEAM_REF_SELECT = {
  id: true,
  allDivisions: true,
  restrictClaims: true,
  divisions: { select: { divisionId: true } },
} as const;

/** {@link teamRef} from a row loaded with {@link TEAM_REF_SELECT}. */
export function teamRefOf(t: {
  id: string;
  allDivisions: boolean;
  restrictClaims: boolean;
  divisions: { divisionId: string }[];
}): ResourceRef {
  return teamRef({ ...t, divisionIds: t.divisions.map((d) => d.divisionId) });
}

function notFound(
  code:
    | 'TASK_NOT_FOUND'
    | 'SUBMISSION_NOT_FOUND'
    | 'MESSAGE_NOT_FOUND'
    | 'ATTACHMENT_NOT_FOUND'
    | 'DIVISION_NOT_FOUND'
    | 'TEAM_NOT_FOUND'
    | 'USER_NOT_FOUND'
    | 'INVITE_NOT_FOUND'
    | 'SESSION_NOT_FOUND'
    | 'REQUEST_TEMPLATE_NOT_FOUND',
  label: string,
): NotFoundError {
  return new NotFoundError(code, `${label} not found`);
}
