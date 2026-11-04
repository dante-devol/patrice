// Pure presentation helpers for the Tasks slice (ui-tailwind).
//
// These keep the rendering "dumb": the components hold signals + wiring, and every
// derived display decision (status → stamp, single-vs-multi claim, relative time,
// the History event classification, and the client-side colour defaults) lives here
// as a pure function so it can be unit-tested without mounting a component.
//
// Backend gaps this file papers over (flagged in web/design/README.md):
//  - Division/team colours have no `color` column yet, so we derive a stable hue from
//    the entity's name (canonical-name overrides + a hash fallback) client-side.
//  - Discord avatars aren't wired, so avatars fall back to initials on a
//    deterministic colour.

import { Message, Task, TaskStatus, TimelineEntry } from '../../core/api.types';

// ---- Status → rubber stamp ------------------------------------------------

/** A null `statusCache` means nothing has happened yet → render the "open" stamp. */
export function stampStatus(status: TaskStatus | null): TaskStatus {
  return status ?? 'open';
}

/** The element-scoped modifier class for a status stamp (see `.stamp--*`). */
export function stampClass(status: TaskStatus | null): string {
  return `stamp--${stampStatus(status)}`;
}

const STAMP_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  claimed: 'Claimed',
  review: 'In review',
  revising: 'Revising',
  approved: 'Approved',
};

/** The sentence-case words printed on a status stamp. */
export function stampLabel(status: TaskStatus | null): string {
  return STAMP_LABELS[stampStatus(status)];
}

/** The short task ID shown with the tags (the first four hex digits of the UUID). */
export function shortTaskId(id: string): string {
  return id.replace(/-/g, '').slice(0, 4);
}

// ---- Single vs. multi-claim ----------------------------------------------

/**
 * 1-of-1 is the norm: only multi-opening tasks earn the pip slot-gauge. Single-claim
 * tasks show the assignee avatar (or a dashed "unclaimed" circle) instead.
 */
export function isMultiClaim(task: Pick<Task, 'openings'>): boolean {
  return task.openings > 1;
}

// ---- Relative time --------------------------------------------------------

/** Compact "requested · 6h / 5d / 3w" style relative time (data-font, terse). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.round(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

// ---- Colours (client-side defaults until a DB `color` column exists) ------

/** Canonical division hues (web/DESIGN.md), keyed by lowercased name. */
const DIVISION_HUES: Record<string, string> = {
  writing: '#3f5fb5',
  art: '#c0563a',
  scripting: '#2d8060',
  testing: '#7b57a8',
  leadership: '#a57f12',
};

/** Muted palette for entities without a canonical hue (teams, novel divisions). */
const HUE_PALETTE = [
  '#4f6d7a', '#6d5f7a', '#7a5f4f', '#4f7a63', '#7a4f5f',
  '#5b6eae', '#4e8c6a', '#a8763e', '#7e54a3', '#3c5ba0',
];

/** Stable non-negative hash of a string (FNV-1a-ish) for deterministic colour picks. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function paletteColor(seed: string): string {
  return HUE_PALETTE[hash(seed) % HUE_PALETTE.length];
}

/** Division colour: canonical name override, else a stable hash-derived hue. */
export function divisionColor(name: string): string {
  return DIVISION_HUES[name.trim().toLowerCase()] ?? paletteColor(`div:${name}`);
}

/** Team colour: no canonical set, so always a stable hash-derived hue. */
export function teamColor(name: string): string {
  return paletteColor(`team:${name}`);
}

/** Avatar fill colour for the initials fallback (stable per user). */
export function avatarColor(seed: string): string {
  return paletteColor(`user:${seed}`);
}

// ---- History actors ------------------------------------------------------

/** Up-to-two-letter initials for an avatar fallback. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---- History (system events + comments, one stream) ----------------------

export type HistoryNodeKind =
  | 'request'
  | 'claim'
  | 'leave'
  | 'submit'
  | 'return'
  | 'approve'
  | 'comment'
  | 'neutral';

/** A reference from a timeline event to the submission it's about. */
export interface SubmissionRef {
  submissionId: string;
  actorId: string;
  version: number;
}

export interface HistoryReply {
  id: string;
  kind: 'comment' | 'system';
  node: HistoryNodeKind;
  /** The rendered line for system replies; the body for comments. */
  text: string;
  message: Message | null;
  createdAt: string;
  actorId: string | null;
}

export interface HistoryEvent {
  id: string;
  kind: 'comment' | 'system';
  node: HistoryNodeKind;
  /** The rendered line for system events; the body for comments. */
  text: string;
  message: Message | null;
  createdAt: string;
  /** Set on "submitted vN" events so the UI can open (and comment on) the submission. */
  submission: SubmissionRef | null;
  /** One-level replies threaded under this event (review decisions + comments). */
  replies: HistoryReply[];
  actorId: string | null;
}

const DECISION_WORD = { approve: 'approved', return: 'returned', reject: 'rejected' } as const;

/** How one timeline entry reads, and its node colour. */
function describe(
  e: TimelineEntry,
  name: (id: string | null) => string,
): { node: HistoryNodeKind; text: string } {
  const actor = name(e.actorUserId);
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'task.created':
      return { node: 'request', text: `${actor} requested this task` };
    case 'task.claimed':
      return { node: 'claim', text: `${name(p['userId'] as string)} claimed an opening` };
    case 'task.left':
      return { node: 'leave', text: `${name(p['userId'] as string)} left` };
    case 'task.claimant_evicted':
      return { node: 'leave', text: `${actor} removed ${name(p['userId'] as string)}` };
    case 'task.requester_changed':
      return { node: 'neutral', text: `requester changed to ${name(p['toUserId'] as string)}` };
    case 'task.claims_changed':
      return {
        node: 'neutral',
        text:
          p['claimsClosed'] === true
            ? `${actor} closed claims`
            : p['claimsClosed'] === false
              ? `${actor} reopened claims`
              : `${actor} set openings to ${p['openings']}`,
      };
    case 'task.completed':
      return { node: 'approve', text: `${actor} marked the task complete` };
    case 'task.retired':
      return { node: 'neutral', text: `${actor} retired the task` };
    case 'task.revived':
      return { node: 'neutral', text: `${actor} revived the task` };
    case 'submission.submitted':
      return { node: 'submit', text: `${actor} submitted v${p['submissionNo']} for review` };
    case 'submission.reviewed': {
      const decision = p['decision'] as keyof typeof DECISION_WORD;
      return {
        node: decision === 'approve' ? 'approve' : 'return',
        text: `${actor} ${DECISION_WORD[decision]} v${p['submissionNo']}`,
      };
    }
    case 'submission.retired':
      return { node: 'neutral', text: `${actor} removed v${p['submissionNo']}: ${p['reason']}` };
    default:
      // Unreachable while the switch covers the catalog; a newer server's event reads raw.
      return { node: 'neutral', text: (e as { type: string }).type };
  }
}

function commentReply(m: Message): HistoryReply {
  return {
    id: m.id,
    kind: 'comment',
    node: 'comment',
    text: m.deletedAt ? '(deleted)' : m.body,
    message: m,
    createdAt: m.createdAt,
    actorId: m.senderUserId,
  };
}

/**
 * Build the History as one threaded stream from the task's timeline (typed events)
 * and its thread (comments). A "submitted vN" event carries that submission's review
 * decisions and the comments about it as replies; top-level comments carry theirs.
 */
export function buildHistory(
  timeline: TimelineEntry[],
  messages: Message[],
  resolveName: (id: string | null) => string,
): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  // The latest "submitted" event per submission hosts its decisions and comments.
  const hostFor = new Map<string, HistoryEvent>();
  const pending: { submissionId: string; reply: HistoryReply }[] = [];

  for (const e of timeline) {
    const { node, text } = describe(e, resolveName);
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'submission.reviewed') {
      pending.push({
        submissionId: p['submissionId'] as string,
        reply: { id: e.id, kind: 'system', node, text, message: null, createdAt: e.occurredAt, actorId: e.actorUserId },
      });
      continue;
    }
    const ev: HistoryEvent = {
      id: e.id,
      kind: 'system',
      node,
      text,
      message: null,
      createdAt: e.occurredAt,
      submission:
        e.type === 'submission.submitted'
          ? { submissionId: p['submissionId'] as string, actorId: e.actorUserId ?? '', version: p['submissionNo'] as number }
          : null,
      replies: [],
      actorId: e.actorUserId,
    };
    if (ev.submission) hostFor.set(ev.submission.submissionId, ev);
    events.push(ev);
  }

  for (const m of messages) {
    if (m.submissionId && hostFor.has(m.submissionId)) {
      pending.push({ submissionId: m.submissionId, reply: commentReply(m) });
      for (const r of m.replies ?? []) pending.push({ submissionId: m.submissionId, reply: commentReply(r) });
      continue;
    }
    events.push({
      ...commentReply(m),
      submission: null,
      replies: (m.replies ?? []).map(commentReply),
    });
  }
  for (const { submissionId, reply } of pending) hostFor.get(submissionId)?.replies.push(reply);
  for (const host of hostFor.values()) host.replies.sort(byTime);

  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => byTime(a.e, b.e) || a.i - b.i)
    .map(({ e }) => e);
}

function byTime(a: { createdAt: string }, b: { createdAt: string }): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
