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
//  - Discord avatars (Slice 8) aren't wired, so avatars fall back to initials on a
//    deterministic colour.

import { Message, Task, TaskStatus } from '../../core/api.types';

// ---- Status → rubber stamp ------------------------------------------------

/** A null `statusCache` means nothing has happened yet → render the "open" stamp. */
export function stampStatus(status: TaskStatus | null): TaskStatus {
  return status ?? 'open';
}

/** The element-scoped modifier class for a status stamp (see `.stamp--*`). */
export function stampClass(status: TaskStatus | null): string {
  return `stamp--${stampStatus(status)}`;
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

/** Canonical division hues from the design spike, keyed by lowercased name. */
const DIVISION_HUES: Record<string, string> = {
  writing: '#3c5ba0',
  art: '#b0573c',
  scripting: '#2e7d5b',
  testing: '#7e54a3',
  leadership: '#a9810f',
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

// ---- User-order timeline colours ------------------------------------------

const GOLDEN_ANGLE_DEG = 137.508;
const USER_COLOR_START_HUE = 200; // Start at teal/blue — feels neutral as user #1

/**
 * Deterministic hue for the nth user to appear in a task's history
 * (ordinal is 1-based: first person seen = 1, second = 2, …).
 *
 * variant:
 *  'full' — saturated, for comment fills and submission borders
 *  'soft' — desaturated, for other system-event borders
 *  'bg'   — very light tint, for submission node backgrounds
 */
export function userOrderColor(ordinal: number, variant: 'full' | 'soft' | 'bg' = 'full'): string {
  const h = (USER_COLOR_START_HUE + (ordinal - 1) * GOLDEN_ANGLE_DEG) % 360;
  if (variant === 'full') return `hsl(${h.toFixed(1)},62%,42%)`;
  if (variant === 'soft') return `hsl(${h.toFixed(1)},26%,60%)`;
  return `hsl(${h.toFixed(1)},50%,92%)`;
}

/** Extract the primary actor user-ID from a raw system message body. */
export function parseActorId(body: string): string | null {
  const m = body.match(/^(?:User|Reviewer) (\S+)/i);
  return m ? m[1].replace(/[.,]$/, '') : null;
}

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

/** Classify a system message body into a timeline node kind (drives node colour). */
export function systemNodeKind(body: string): HistoryNodeKind {
  const b = body.toLowerCase();
  if (b.includes('claimed')) return 'claim';
  if (b.includes('left this task')) return 'leave';
  if (b.includes('submitted')) return 'submit';
  if (b.includes('returned')) return 'return';
  if (b.includes('approved') || b.includes('marked this task complete')) return 'approve';
  if (b.includes('rejected')) return 'return';
  if (b.includes('requester changed')) return 'neutral';
  return 'neutral';
}

/**
 * Humanise a senderless system body for the History stream. The server stores raw ids
 * ("User <id> claimed this task.") for audit-PII discipline; here we resolve them to
 * display names and use the domain phrasing ("claimed an opening", "submitted v2").
 */
export function humanizeSystemBody(
  body: string,
  resolveName: (id: string) => string,
): string {
  let m: RegExpMatchArray | null;

  if ((m = body.match(/^User (\S+) claimed this task\.?$/))) {
    return `${resolveName(m[1])} claimed an opening`;
  }
  if ((m = body.match(/^User (\S+) left this task\.?$/))) {
    return `${resolveName(m[1])} left`;
  }
  if ((m = body.match(/^User (\S+) marked this task complete\.?$/))) {
    return `${resolveName(m[1])} marked the task complete`;
  }
  if ((m = body.match(/^Requester changed to user (\S+?)\.?$/))) {
    return `requester changed to ${resolveName(m[1])}`;
  }
  if ((m = body.match(/^User (\S+) submitted version (\d+)\.?$/))) {
    return `${resolveName(m[1])} submitted v${m[2]} for review`;
  }
  if ((m = body.match(/^Reviewer (\S+) (approved|returned|rejected) version (\d+)\.?$/))) {
    return `${resolveName(m[1])} ${m[2]} v${m[3]}`;
  }
  // Unknown shape: best-effort id→name substitution so we never leak a raw uuid.
  return body.replace(/\b[Uu]ser (\S+?)([.,]?)(\s|$)/g, (_all, id, punct, tail) =>
    `${resolveName(id)}${punct}${tail}`,
  );
}

/** The actor + version a "submitted version N" system body refers to, for linking
 *  a submit event to its Submission (the web Message view carries no submissionId). */
export function parseSubmitEvent(body: string): { actorId: string; version: number } | null {
  const m = body.match(/^User (\S+) submitted version (\d+)\.?$/);
  return m ? { actorId: m[1], version: Number(m[2]) } : null;
}

export interface HistoryReply {
  id: string;
  kind: 'comment' | 'system';
  node: HistoryNodeKind;
  /** Resolved line for system replies; raw body for comments. */
  text: string;
  message: Message;
  createdAt: string;
  /** The user who caused this event (parsed from body for system, senderUserId for comments). */
  actorId: string | null;
}

export interface HistoryEvent {
  id: string;
  kind: 'comment' | 'system';
  node: HistoryNodeKind;
  /** Resolved, human-readable line for system events; raw body for comments. */
  text: string;
  message: Message | null;
  createdAt: string;
  /** Set on "submitted vN" events so the UI can open the matching submission. */
  submission: { actorId: string; version: number } | null;
  /** One-level replies (review decisions + comments) threaded under this event. */
  replies: HistoryReply[];
  /** The user who caused this event (parsed from body for system, senderUserId for comments). */
  actorId: string | null;
}

function reply(m: Message, resolveName: (id: string | null) => string): HistoryReply {
  const actorId = m.kind === 'system' ? parseActorId(m.body) : m.senderUserId;
  return m.kind === 'system'
    ? { id: m.id, kind: 'system', node: systemNodeKind(m.body), text: humanizeSystemBody(m.body, resolveName), message: m, createdAt: m.createdAt, actorId }
    : { id: m.id, kind: 'comment', node: 'comment', text: m.body, message: m, createdAt: m.createdAt, actorId };
}

/**
 * Build the unified History as a threaded stream: a synthetic "requested" event (the
 * task has no system message of its own) plus each top-level message, with its one-level
 * replies nested beneath it. So a "submitted vN" event carries the return decision and
 * any discussion as its own thread (the design's "comments on the submission"), and
 * top-level comments carry their replies. System bodies are humanised + classified.
 */
export function buildHistory(
  task: Pick<Task, 'requesterUserId' | 'createdAt'>,
  messages: Message[],
  resolveName: (id: string | null) => string,
): HistoryEvent[] {
  const requested: HistoryEvent = {
    id: 'requested',
    kind: 'system',
    node: 'request',
    text: `${resolveName(task.requesterUserId)} requested this task`,
    message: null,
    createdAt: task.createdAt,
    submission: null,
    replies: [],
    actorId: task.requesterUserId,
  };

  const events: HistoryEvent[] = messages.map((m) => {
    const base = reply(m, resolveName);
    return {
      ...base,
      message: m,
      submission: m.kind === 'system' ? parseSubmitEvent(m.body) : null,
      replies: (m.replies ?? []).map((r) => reply(r, resolveName)),
    };
  });
  events.unshift(requested);

  // Stable chronological order of top-level events; replies keep their own order.
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const t = new Date(a.e.createdAt).getTime() - new Date(b.e.createdAt).getTime();
      return t !== 0 ? t : a.i - b.i;
    })
    .map(({ e }) => e);
}
