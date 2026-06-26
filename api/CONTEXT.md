# API

The NestJS backend tier. Owns the domain model (via Prisma), the Cedar access engine, the OpenAPI contract surface, and the background-job queue. The only tier that talks to Postgres and the only tier that enforces permissions.

## Language

Cross-cutting domain entities (Task, Submission, Division, Role, Team, User, Questionnaire, Message, Attachment, Invitation, Activity) are defined in `docs/ARCHITECTURE.md §2.1`. Below are the API-tier load-bearing terms that the grilling crystallized — the ones that are dense enough to need their own precise word.

### Authorization

**Effective Admin**:
An *active* user holding at least one `permit` grant on one of `{grant:create/update/retire, role:create/update/retire}` at `scope_kind='global'`. Scoped grants don't count. Drives both bootstrap re-entry and the administrability invariant.
_Avoid_: Admin, Org Admin (those refer to the role, not the predicate)

**Action**:
A closed `resource:verb` string from the fixed vocabulary in `docs/ARCHITECTURE.md §2.3`. Admins grant actions to roles; they cannot invent new ones. Reads are not gated in v1 (no `read`/`view` action).
_Avoid_: Permission (that's the granted/denied verdict), Capability

**Grant**:
A configuration row attaching an Action to a Role at a Scope Shape. Source data the engine projects into Cedar; not itself the enforcement.
_Avoid_: Permission (that's the engine verdict), Policy (that's Cedar's term)

**Scope Shape**:
One of five enums on `grant.scope_kind`: `global`, `specific_group` (a fixed division or team), `own_group` (any division or team the actor is a member of), `own` (the actor is the resource's owner), `role` (the granted role is pinned). The projector picks one Cedar template per shape — and for `own`, one template per resource owner-relation (see Own Family).
_Avoid_: Permission Scope, Scope Type

**Own Family**:
The four Cedar templates the projector binds when a Grant's `scope_kind='own'`: `own_as_requester`, `own_as_claimant`, `own_as_sender`, `own_as_uploader`. Admins see only `own` in the matrix UI; the action→template map in the projector picks the right one.
_Avoid_: Owner Templates, Ownership Policies

**Baseline Self-Access**:
The single static Cedar permit policy granting `user:update` on `self == principal`. Distinct from grants on the `user:update` action at `scope_kind='global'` (which permit updating *others*).
_Avoid_: Self Permission, Own Profile Access

**Retired-as-Hard-Deny**:
The static Cedar `forbid` policy that denies any action when its target or actor has `lifecycle_state='retired'`. Overrides any permit; the load-bearing structural use of Cedar's deny-overrides-permit.
_Avoid_: Retirement Block, Retired Forbid

### Task lifecycle

**Status Min-Rule**:
The fixed function computing a task's status as the *lowest* state among its **Counted Slots**, ordered `open < claimed < revising < review < approved`. A task reaches Approved only when every counted slot is Approved AND there is at least one counted Approved slot.
_Avoid_: Status Aggregation, Status Roll-Up

**Counted Slot**:
A claimant slot that contributes to the Status Min-Rule. Excludes rejected submissions and closed-unfilled spots.
_Avoid_: Active Slot (that includes unfilled-but-open slots), Contributing Slot (used informally; this is the canonical term)

**Empty Contributing Set Floor**:
The rule that when the Counted Slot set is empty (e.g. every claimant was rejected and claims are closed), `status_cache='claimed'` — never vacuously Approved. Forces the requester to explicitly act.
_Avoid_: Empty-Set Status, Vacuous Approval Block

**Submission Number**:
The integer column `submission_no` — the resubmission counter (v1, v2, v3), part of the row's identity. Distinct from `submission.version` which is the global optimistic-lock counter and changes on every review write.
_Avoid_: Version (collides with the lock), Attempt Number, Iteration

**Manual Complete**:
The `task:complete` action — forces a task's status to Approved regardless of submission states. Outstanding submissions stay in their last state; the UI surfaces them as no-longer-required.
_Avoid_: Force Approve, Bypass

### Identity & bootstrap

**Bootstrap Mode**:
The startup state where no Effective Admin exists. The API prints a one-time ephemeral key to stdout and exposes a passcode-gated system invitation; the mode closes the instant an Effective Admin exists.
_Avoid_: Setup Mode (Setup is the user-facing page name; Bootstrap Mode is the server state)

**Bootstrap Key**:
The ephemeral CSPRNG passcode for the system invitation. Lives only for the process run, never persisted, dies on exit. A leaked old key cannot be replayed.
_Avoid_: Setup Token, Admin Key

**Verified Identity**:
A `user_identity` row with `verified_at IS NOT NULL`. Google/Discord (OAuth) identities start verified; password identities verify via the email-token flow. Bootstrap auto-verifies regardless of the org's verification policy.
_Avoid_: Confirmed Email, Validated Account

**Discord Auth Identity**:
A `user_identity` row with `provider='discord'`, `provider_subject=<discord snowflake>` — the connection-independent **sign-in** credential, minted from the app-level OAuth client (`DISCORD_CLIENT_ID/SECRET`). It is the auth path for "log in with Discord" and is **distinct** from the Discord Integration Link (`external_identity`), which is per-connection and feeds role sync only (ADR 0005). One OAuth consent may create both, but they are separate rows with different drivers.
_Avoid_: Discord link (that names the integration link), Discord account

### Entity lifecycle

**Retire**:
The soft-delete action — sets `lifecycle_state='retired'` and `retired_at=now()`. Distinct from **Revive** (the reverse, during grace), **Reactivate** (the reverse of **Deactivate** — in-life, reversible), and **GC** (the permanent collector). Each `*:revive` is its own separately-granted Action, not an implicit corollary of `*:retire`. **Revive rejection is `409 NOT_REVIVABLE`** (uniform across every `*:revive` endpoint) when the target is active (nothing to revive) or past the Grace Period (GC territory) — this is the pinned contract code, overriding the "422" wording in issue #28's acceptance text. Cedar gates *who*; the `isRevivable` guard gates *whether*; the revive resource resolver omits the `retired` attr so the action doesn't trip its own Retired-as-Hard-Deny.
_Avoid_: Delete, Soft-Delete, Archive

**Grace Period**:
The configurable window after `retired_at` during which Revive is allowed and GC will not collect. Read per-org from `organization.settings.gracePeriodHours` (default 24h) via `GraceService`; `0` disables the window. Recovers from accidental retirement.
_Avoid_: Retention Window, Soft-Delete TTL

**Soft-Retire Default Filter**:
The active-only default on entity **list** queries (`activeFilter`): list endpoints exclude `lifecycle_state='retired'` rows unless `?include=retired` is passed (admin/history views). Targets *retired* only — deactivated rows stay listable. Single-row loads (revive, GC) and task message threads are exempt (retired data degrades-but-stays-visible per §2.10).
_Avoid_: Active Scope, Retirement Hiding

**GC Sweep**:
The lazy collector (`GcService`, Slice 7.3) — a pg-boss job (`singletonKey: 'gc-sweep'`) that permanently deletes entities retired past the Grace Period with no live references. Task aggregates delete as a unit; roles/divisions/teams individually (`ON DELETE RESTRICT` is the DB backstop, logged as `gc.blocked`). A reconciliation pass removes orphaned blobs. `POST /gc/sweep` + `/gc/sweep/dry-run` are the manual hooks.
_Avoid_: Garbage Collector (the term), Reaper, Purge

**Scrub-in-Place**:
The permanent user-erasure operation. Keeps the `app_user` row (preserving FK validity) with `id` + `display_name` only; purges PII and satellites; auto-revokes invitations the user issued. Patrice's GDPR-style erasure path.
_Avoid_: User Deletion, Account Removal

### Questionnaires

**Questionnaire Ownership Exclusivity**:
A `questionnaire` row is owned by **exactly one** of a division (`owner_division_id`) or
a task (`owner_task_id`) — each column UNIQUE, with a CHECK that exactly one is non-null.
The schema is the backstop behind "editing a division default never mutates existing
tasks": a task copy is always a separate row. `PUT /divisions/:id/questionnaire` is
**upsert-in-place** — first call inserts the division-owned row, later calls rewrite the
`question` children under the same stable id (the UNIQUE prevents a sibling).
_Avoid_: Default Questionnaire Link (there is no `division.default_questionnaire_id`)

### Cross-cutting

**Config Version**:
The monotonic `organization.config_version` counter that bumps on any role/grant/retirement/settings change. The Cedar input cache keys on it; the column itself is read fresh from DB per request (the inputs it keys are cached, the key is not).
_Avoid_: Cache Generation, Schema Version

**Activity Payload Discipline**:
The rule that `activity.payload jsonb` contains **IDs only** — never PII strings. Sidesteps the audit-immutability-vs-data-erasure conflict; the `logActivity` helper Zod-validates per-verb to enforce it.
_Avoid_: Audit Privacy Rule

### Notifications

**Event Seq**:
The monotonic `notification.event_seq` (bigint), counted per `(subject_type, subject_id, type)` at emit time. With `UNIQUE(recipient_user_id, type, subject_id, event_seq)` it is the **idempotency guard**: a retry carrying the same tuple collides and no-ops (`createMany skipDuplicates`). Resolved inline in the request transaction in v1, so the seq is auto-computed; an explicit seq is passed only to exercise the retry path.
_Avoid_: Sequence Number, Notification Version

**Recipient Snapshot**:
The cohort resolved **at event time** and written as one `notification` row per recipient — never re-resolved at delivery. The sender is universally suppressed from their own cohort ({@link computeRecipients}). A claimant who leaves between event and read still keeps their row.
_Avoid_: Recipient List, Subscriber Set

**PubSubPort**:
The fan-out seam (`publish(userId, ev)` / `subscribe(userId, cb)`). v1 binds the in-process adapter (single instance); the post-v1 multi-instance path is a Postgres `LISTEN/NOTIFY` adapter behind the same port. Carries a content-free **sync** ping only — durability never rides the stream. The Process Role split does **not** force the `LISTEN/NOTIFY` adapter on its own — every publisher and the SSE subscriber live in the `api` role; it is forced only when a `worker`-role path first publishes (guarded by a pre-split assertion).
_Avoid_: Event Bus, Broker

**Process Role**:
The `PROCESS_ROLE` toggle (resolved into an injected `ProcessRole` provider) selecting a process's job from one image: `api` (HTTP only, N replicas, freely restartable) or `worker` (no HTTP — pg-boss consumers + cron + GC + the Gateway socket; holds the singletons and the only copy of the cipher key). Dev runs one combined process; prod splits. The Gateway socket is the one strict single-instance guard; multi-`worker` leader election is the deferred HA seam.
_Avoid_: Process Type, Mode, Web/Worker Dyno

**Claim Eligibility AND-Composition**:
The rule that `division.restrict_claims` and `team.restrict_claims` are AND-composed: if either is true the claimant must hold the corresponding inherent role. Evaluated in Cedar via the `task:assign @ own_as_claimant` template; reads `principal.memberDivisions` and `principal.memberTeams`.
_Avoid_: Membership Check, Eligibility Rule

### Integrations & external sync

**Discord Integration Link**:
An `external_identity` row binding a Patrice user to their Discord account **within one connection** — the unit role sync resolves per user. User-driven to opt in; carries `external_avatar_hash` (#52). Distinct from the [Discord Auth Identity] (login) — retiring a connection drops the link and its role sync, but never the user's ability to sign in (ADR 0005).
_Avoid_: Discord auth identity (that's the sign-in credential), Account link

**Edge**:
One `(connection, external user, mapped group/role)` membership fact — the unit the reconciler converges. Binary: the user either holds the mapped role or doesn't, on each side.
_Avoid_: Membership, Assignment, Link (Link is the user↔account identity, not the role fact)

**Sync Baseline**:
The last-converged state of an Edge, persisted per `(connection, external user, external group)`. The anchor for Divergence Attribution; **every write updates it, including the bot's own outbound pushes**, so the writer never re-reacts to itself.
_Avoid_: Watermark (implies a monotonic stream offset — this is a state snapshot), Shadow State, `last_synced_state` (the column name, not the concept)

**Divergence Attribution**:
The rule that settles ~all reconciliation: for a binary Edge against a trustworthy Sync Baseline, the two sides can only disagree if **exactly one** diverged from the baseline — that side is the unambiguous origin, and its state propagates. No tiebreaker (time or precedence) is consulted in the normal case. **Native-grant carve-out:** when the diverging side is Discord *removing* a role that Patrice holds **natively** (`source=patrice`), the attribution can't be honored — sync never revokes an admin-authored grant — so Patrice is authoritative for that Edge and the role is **re-asserted outbound** instead of stalling. (Integration-sourced roles still propagate the Discord-side removal as a Patrice revoke.) This is what makes bidirectional ⊇ outbound for native roles.
_Avoid_: Conflict Resolution (that's only the cold-baseline path), LWW (we explicitly do not time-order the common case)

**Cold-Baseline Conflict**:
The only case a tiebreaker is needed — the Sync Baseline can't attribute (first sync, lost/never-converged baseline). Resolved by **Discord audit-log time** when the entry is fetchable, else by **Source Precedence**. A Gateway/REST membership fetch carries no per-Edge timestamp, so audit-log is the sole authoritative Discord-side change-time.
_Avoid_: Race, Flap

**Source Precedence**:
The configured fallback winner for a Cold-Baseline Conflict when no audit-log time is available — a per-mapping `conflict_winner` (`patrice | external`). Deterministic, not time-based.
_Avoid_: Priority, Authority (Authority is the broader source-of-truth posture)

**Doorbell**:
The Gateway listener's role — on a relevant Discord event it only `enqueueSoon`s a reconcile for the connection; it never reads or writes Edge state. One writer (the reconciler), one correctness path. Fast-but-best-effort: a missed event silently degrades to the Reconcile Floor, so it is health-monitored, never trusted as a guarantee. Revocation latency on this path = debounce (~5s) + reconcile duration, an explicit monitored SLO — not the hard guarantee.
_Avoid_: Listener (too generic), Webhook (it's a Gateway socket, not an HTTP callback), Trigger

**Reconcile Floor**:
The guaranteed max-staleness bound enforced independently of the Doorbell, **adaptive to Gateway health**: **6h** when the socket is healthy, tightened to **30min** while degraded (socket down). A single ~30-min supervisory tick enforces whichever bound applies (healthy: reconcile only past 6h; degraded: every tick) and, when degraded, also re-attempts Gateway restoration (debounced) — layered *over* fast second-scale socket backoff, which handles transient drops. Replaces the former daily 02:00 sweep. Surfaced to admins as `next_reconcile_at` = `last_sync_at` + the active floor.
_Avoid_: Cron Sweep, Daily Sync, Backstop Poll

**Gateway State**:
The persisted, admin-visible projection of the Doorbell socket's health — `gateway_state` on the connection (`down` / `connecting` / `connected` / `degraded`), written by the worker on each transition and read by the api role. The in-memory `session.healthy` drives the live socket; this column is its durable mirror so admins (and the api role) see Gateway health without reading worker logs. Transitions also emit `integration.gateway_*` activity. `degraded` = socket down past backoff (the Reconcile Floor has tightened).
_Avoid_: Socket Status, Health Flag (that's the in-memory `healthy` bool)

**Native-Authority Carve-Out**:
The rule that security-critical roles (Org-Admin / governance) stay Patrice-native and admin-managed — never mapped through an integration — so their revocation is a synchronous Patrice write, never gated on sync latency or a live Gateway. This, not the Doorbell SLO, is the actual revocation guarantee; it caps the blast radius of any missed or slow integration event to non-critical membership.
_Avoid_: Critical Role Exclusion, Admin Role Lock

**SecretCipherPort**:
The seam for custodying a per-connection provider secret (the Discord bot token, the one long-lived secret Patrice must hold to push outbound). `credentials_ref` holds a **cipher-tagged handle** the port resolves: `aead:<ciphertext>` inline (self-host default, key in env), `vault:<path>` / `kms:<keyid>:<wrapped>` for cloud. Decrypted **only in the worker role**, which alone holds the key; never returned by any read endpoint. App-level secrets (`DISCORD_CLIENT_SECRET`, peppers) stay env-only and are out of scope — this narrows §2.8's "custodies nothing" to the inbound/OAuth paths.
_Avoid_: KeyVault, Secret Store (those name one adapter, not the seam), TokenCrypto
