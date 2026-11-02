# Slice 4 — Tasks: Creation, Claiming & Messages

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slice 3 (questionnaires) and Slice 2 (divisions/teams,
engine + task actions).*

**Goal.** The first real **work** flow: a requester **creates** a task (which copies its division's
default questionnaire and seeds **openings**), users **claim** it within the openings, the requester
manages claims (close, add openings, change requester), and everyone holds a **threaded message**
conversation on it. Status here ranges over **Open → Claimed** (submissions arrive in Slice 5).

**Acceptance demo.**
1. A user with `task:create @ Writing` creates a task in Writing → it gets a **copy** of Writing's
   questionnaire and `openings=1` (from division default).
2. A claimant with `task:assign @ Writing` claims it → status **Claimed**; openings full.
3. A second claimant cannot claim (full); the requester **adds an opening**, the second claims.
4. A claimant **leaves** before submitting → their slot frees (status back toward Open if not
   full/closed). The requester **closes the task to new claims**.
5. Anyone permitted posts a **message** (markdown, optional attachment); the requester replies in a
   **thread** under it (one level deep — a reply-to-a-reply is rejected).
6. The requester **changes the requester** to another user.

**In scope.** `task`, `task_claimant`, `message`, `attachment` tables; questionnaire **copy** on task
create; the per-task `task:configure_questionnaire` (edit the copy, **locked once a submission
exists** — no submissions until Slice 5, so unlocked here); claim/leave/openings (`task:assign`,
`task:manage_claims`), `task:change_requester`; messages (`message:*`, one-level threads) with
attachments; the **object-storage** adapter (first attachment use); `status_cache` computed as
Open/Claimed (the full min-rule is finished in Slice 5).

**Not in scope.** Submissions & review (Slice 5); notifications (Slice 6).

## Schema (add)
```
task           id, organization_id, name, description text (markdown), division_id (req), team_id null (opt),
               requester_user_id, openings int, claims_closed bool default false,
               status_cache enum null ('open'|'claimed'|'review'|'revising'|'approved'),
               lifecycle_state, retired_at, version, created_at, updated_at
               -- this task's questionnaire is reached via the inverse relation:
               --   questionnaire WHERE owner_task_id = task.id  (Slice 3)
               INDEX (division_id),(team_id),(status_cache),(requester_user_id)
task_claimant  id, task_id→task, user_id→app_user, joined_at, has_submitted bool default false, left_at null
               UNIQUE(task_id,user_id)
message        id, task_id→task, kind ('comment'|'system'), sender_user_id null,
               parent_message_id uuid null (CHECK: parent's parent_message_id IS NULL),
               submission_id uuid null (FK added Slice 5), body text,
               lifecycle_state, retired_at, created_at, edited_at null, version
               INDEX (task_id, created_at)
attachment     id, organization_id, message_id null, answer_id null (CHECK exactly one set; answer_id FK in Slice 5),
               uploader_user_id, storage_key text, filename, content_type, byte_size bigint,
               kind ('image'|'text'|'audio'|'model'|'other'), checksum, lifecycle_state, retired_at, created_at
```

## Task creation & questionnaire copy
On `POST /tasks`: validate the actor's `task:create` scope vs. the chosen division/team. **The
division MUST have a questionnaire** (i.e. some `questionnaire` row with `owner_division_id =
$div_id` — see Slice 3); if none exists, return `422 NO_DEFAULT_QUESTIONNAIRE` (a coordination-
only division is the explicit "empty `question[]`" case, not the "no questionnaire" case). Then:
**deep-copy** the division's questionnaire into a new `questionnaire` row with `owner_task_id =
task.id` (+ fresh `question` rows with new IDs); set `openings = division.default_openings`;
`status_cache='open'`.

**Insertion order** (no chicken-and-egg — `task.questionnaire_id` was removed in Slice 3): insert
`task` first; then insert `questionnaire` with `owner_task_id = task.id`; then `question` rows.
All within one transaction.

## Claiming, openings, requester
- `task:assign` (self = claim): allowed only if not `claims_closed` and `count(active claimants) <
  openings`. **Claim-eligibility is evaluated in Cedar** by the `task:assign @ own_as_claimant`
  template's `when` clause, AND-composing `division.restrict_claims` and `team.restrict_claims`
  (Slice 2): if either is true the principal must hold that group's inherent role (via its
  `memberDivisions`/`memberTeams` set attribute). Reads current materialized Patrice state — never
  blocks on integration sync. On claim, insert `task_claimant`.
- **Leave:** mark the claimant left; **frees the slot unless `has_submitted`** (no submits yet in
  Slice 4, so leaving always frees here). `task:manage_claims` lets the requester **close claims** and
  **add openings** (`openings++`), subject to `division.openings_locked`.
- `task:change_requester` reassigns `requester_user_id` (own=current requester, or lead/admin scope).
- **status_cache** recompute (Slice-4 subset): `open` if (open spots & not closed), else `claimed`.

## Messages
- `message:create` posts a `comment` (markdown, optional attachments). Threads: a reply sets
  `parent_message_id` to a **top-level** message; the CHECK + an app guard reject reply-to-reply.
- `message:update`/`message:retire` (own, or scoped) — edited marker + soft retire.
- **System messages** (`kind='system'`, senderless) are emitted by the system; in Slice 4 the only
  ones are claim/leave/requester-change events (consumed by Slice 6 notifications later).

## Object storage (introduced here)
A **storage port** with two drivers: S3-compatible (AWS SDK v3 / MinIO) and local-fs. Upload:
`POST /attachments` (`attachment:create`) streams to the store, returns metadata; the caller
references `attachment.id` from a message (or, in Slice 5, an answer). Download streams from the store
(ungated read in v1). Enforce `content_type`/size on upload.

**Multi-instance caveat:** the **local-fs driver requires single-instance API** (uploads land on
one instance's disk; downloads on a different instance 404). Multi-instance deployments must use
the S3-compatible driver. The S3 driver is the production default; local-fs is the lightweight
self-host option.

## API endpoints
```
POST   /tasks                         (task:create)            {name,description,divisionId,teamId?}
GET    /tasks                         (faceted+keyset list)    ?division=&team=&status=&claimant=&requester=&after=&limit=
GET    /tasks/:id
PATCH  /tasks/:id                     (task:update)            {name?, description?}   -- pure metadata only; 422 on any other field
POST   /tasks/:id/retire              (task:retire)            -- withdraw
GET    /tasks/:id/questionnaire
PUT    /tasks/:id/questionnaire       (task:configure_questionnaire)  -- locked once a submission exists (Slice 5)
POST   /tasks/:id/claim               (task:assign, own)
POST   /tasks/:id/leave               (task:assign, own)
POST   /tasks/:id/claims              (task:manage_claims)     {openingsDelta?, claimsClosed?}
POST   /tasks/:id/requester           (task:change_requester)  {userId}
GET    /tasks/:id/messages            (keyset)
POST   /tasks/:id/messages            (message:create)         {body, parentMessageId?, attachmentIds?}
PATCH  /messages/:id                  (message:update)
POST   /messages/:id/retire           (message:retire)
POST   /attachments                   (attachment:create)      multipart
GET    /attachments/:id               -- download (ungated read)
```
**List conventions (decided):** **keyset/cursor** pagination — default newest-first using the UUIDv7
PK as the cursor; other sorts use `(sortKey,id)`. **Faceted filters** are typed query params
(`division`, `team`, `status`, `claimant`, `requester`, date ranges) each backed by an index,
AND-combined, with `in:` for multi-value. No free-text search (deferred).

**`task:update` field scope** (and the general PATCH convention applies — see Slice 2): PATCH
accepts **only** `{name?, description?}`. **`division_id` and `team_id` are not editable in v1**
(changing division cascades into questionnaire/submission/eligibility semantics not worth
designing for the rare "wrong division at create-time" case — recovery is retire + recreate).
Lifecycle, authority, and aggregate-structure changes go through named actions:
`requester_user_id` → `/requester` (`task:change_requester`); `openings` / `claims_closed` →
`/claims` (`task:manage_claims`); questionnaire → `/questionnaire`
(`task:configure_questionnaire`); `lifecycle_state` → `/retire` & `/revive` (Slice 7).
**Silent ignore is forbidden** — PATCH `422`s on any other field name in the payload.

## Web (Angular)
- **Task list** (faceted filter bar + keyset infinite-scroll), **Task create** form, **Task detail**
  page: header (division/team/status/requester/openings), description (markdown render), the
  **questionnaire** shown read-only (answering arrives in Slice 5), claim/leave/close/add-opening
  controls (reflecting grants), and the **message thread** (top-level messages + one-level reply
  threads, compose box with attachment upload).

## Tests
- Create copies the questionnaire (editing the division default afterward does **not** change the
  task's copy).
- Openings: claim fills; over-claim rejected; add-opening allows; close blocks new claims; leave frees
  the spot.
- Eligibility honored (enforced mode rejects a non-member claim).
- Messages: thread one level only (reply-to-reply → 422); edit marker; soft retire.
- Attachment upload/download round-trip on both storage drivers; bad type/size rejected.
- Keyset pagination stable under concurrent inserts; faceted filters index-backed.

**Done when** the demo passes — tasks are created, claimed, and conversed on, end-to-end.
