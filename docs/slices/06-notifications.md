# Slice 6 — Notifications

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slices 1–5 (the events that generate notifications:
claim, submit, review, complete, invite, retired-data block).*

**Goal.** Deliver awareness: persist **notifications** generated from task/system events and push
them to the client live over **SSE**, with the client reconciling against the durable table.

**Acceptance demo.**
1. User A is added to a task or User A's task gets a submission/review → a `notification` row is
   created for the relevant recipient(s).
2. A logged-in recipient with the app open sees the **unread badge** increment **live** (SSE),
   without refresh.
3. Killing the SSE connection and reconnecting **reconciles** missed notifications from the table
   (none lost). Marking read updates `read_at`.

**In scope.** `notification` table; an event→notification mapping (from the system messages / domain
events already emitted in Slices 4–5); the **SSE** endpoint; the recipient-resolution logic (who
cares about each event — requester, claimants, etc.); the Angular signal-backed notifications client
(badge + feed) with reconcile-on-connect.

## Schema (add)
```
notification  id, organization_id, recipient_user_id→app_user,
              type text,                                  -- see the full enumeration below
              subject_type text, subject_id uuid,         -- polymorphic; no FK
              payload jsonb,                              -- recipient cohort snapshot + denormalized facts to render the badge
              event_seq bigint,                           -- monotonic per (subject_type, subject_id, type) for idempotency
              read_at null, created_at
              INDEX (recipient_user_id, read_at, created_at)
              UNIQUE (recipient_user_id, type, subject_id, event_seq)   -- idempotency guard
```
**`type` enumeration** (fixed in v1; matches the recipient matrix below):
`task.submitted`, `task.reviewed_approved`, `task.reviewed_returned`, `task.reviewed_rejected`,
`task.completed`, `task.requester_changed`, `task.claim_joined`, `task.claim_left`,
`task.claims_closed`, `task.openings_added`, `task.retired`, `task.revived`, `message.posted`,
`message.replied`, `message.submission_thread_replied`, `invitation.redeemed`, `retired_block`,
`last_admin_refused`.

## Generation & delivery
- **Generate:** when a domain event fires (a `message`/system event or lifecycle transition), resolve
  recipients per the **recipient matrix below**, **snapshot** the cohort + the small denormalized
  facts needed to render the badge into `payload`, and insert `notification` rows (one per
  recipient). **Sender is universally suppressed from their own recipient set.** Recipients are
  computed at event time, never re-resolved at delivery — a claimant who left between event and
  read still gets their row. Run this in the request transaction or via a pg-boss job;
  **idempotency** is enforced by the `UNIQUE(recipient_user_id, type, subject_id, event_seq)`
  index — retries that re-attempt the same `(verb, subject, recipient, event_seq)` collide on the
  unique constraint and no-op.
- **Deliver (SSE):** `GET /notifications/stream` (`text/event-stream`, cookie-authed) opens a per-user
  stream. The server emits a thin **"sync"** event (not the payload) when that user gets a new
  notification. **Fan-out goes through a small `PubSubPort` interface** (`publish(userId, ev)` /
  `subscribe(userId, cb)`) with an **in-process adapter** for v1's single-instance topology; a
  Postgres `LISTEN/NOTIFY` adapter is the post-v1 path for multi-instance HA — same port, swap
  the adapter, no code-site changes. The client, on any `sync` event or on connect, calls
  `GET /notifications?after=…` to pull the durable rows. **Durability never rides the stream.**

## Recipient matrix (decided in v1; verbs fixed)

| `type` | Triggering event | Recipients |
|---|---|---|
| `task.submitted` | claimant `task:submit` | task requester only |
| `task.reviewed_approved` | requester `task:review {approve}` | the submission's claimant |
| `task.reviewed_returned` | requester `task:review {return}` | the submission's claimant |
| `task.reviewed_rejected` | requester `task:review {reject}` | the submission's claimant |
| `task.completed` | requester `task:complete` | all active claimants |
| `task.requester_changed` | `task:change_requester` | old requester + new requester |
| `task.claim_joined` | someone `task:assign` (claim) | task requester only |
| `task.claim_left` | claimant leaves | task requester only |
| `task.claims_closed` | requester closes claims | all active claimants |
| `task.openings_added` | requester adds opening | nobody (eligible users see it on the list) |
| `task.retired` | `task:retire` | all active claimants (requester excluded — they did it) |
| `task.revived` | `task:revive` | all prior claimants (audit-visible to old participants) |
| `message.posted` (top-level comment) | `message:create` with `parent_message_id=null`, `submission_id=null` | task requester + all active claimants, except sender |
| `message.replied` | `message:create` with `parent_message_id != null` | top-level message's author + all prior thread participants, except sender |
| `message.submission_thread_replied` | `message:create` in a submission's thread (`submission_id` set) | the submission's claimant + task requester, except sender |
| `invitation.redeemed` | someone accepts an invite | invitation's `created_by` if still active (bootstrap = null → nobody) |
| `retired_block` | actor's request denied by `forbid(when resource.retired)` | the actor only (inline error is primary; this is a follow-up backstop) |
| `last_admin_refused` | governance write rejected | the acting admin only (the rejection is synchronous; this is log-style follow-up) |

## API endpoints
```
GET   /notifications/stream                 -- SSE; emits "sync" pings
GET   /notifications        ?after=&limit=  -- durable list (keyset), unread first
POST  /notifications/:id/read               -- set read_at
POST  /notifications/read-all
```

## Web (Angular)
- `NotificationStore` (signal store): an `EventSource` on `/notifications/stream` bridged via
  `toSignal`; on each `sync` (and on connect) it refetches `/notifications`; exposes `unreadCount`
  (computed) and a feed. A header **badge** + dropdown feed; mark-read actions.

## Tests
- Each lifecycle event creates the right notification(s) for the right recipient(s); no duplicates.
- SSE: a recipient with an open stream gets a `sync` ping on a new notification; badge increments live.
- Reconcile: disconnect → create notifications → reconnect → client pulls all missed ones.
- Read-state: mark-read / read-all updates `read_at` and the badge.

**Done when** the demo passes — events surface as live, durable, reconcilable notifications.
