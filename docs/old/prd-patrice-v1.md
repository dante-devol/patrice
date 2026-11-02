# PRD: Patrice — Single-Org Task Tracking, v1

## Problem Statement

A single organization currently coordinates structured work — writing, art, testing, leadership tasks — across approximately twenty Google Drive task-tracking documents, each containing hundreds of entries. The sprawl creates real costs: nobody can answer "what's open in Writing right now?" without manually scanning sheets; submissions take inconsistent shapes (some are pasted prose, some are attached files, some are filled-in custom forms); status updates rely on convention rather than mechanism; the organization runs out of Discord and is accustomed to roles and groupings there, but the sheets have no awareness of identity or membership; and ownership/access decisions live nowhere structurally — they're conventions a reader of the sheets has to know.

The organization needs a single structured system that handles the full lifecycle — requesting work, claiming it, doing it, reviewing it, completing it — with **uniform task shape**, **per-division question structure**, **role-based access**, and **derived status that nobody can fudge**. It should run as a single self-hosted deployment, integrate optionally with Discord for identity sync, and respect data-retirement semantics seriously enough that an audit trail and GDPR-style erasure both work without forcing the team to choose.

## Solution

**Patrice** — a three-tier web application (Angular + NestJS + Postgres) implementing the org's task lifecycle as one configurable engine, deployed as a single self-hosted instance per organization. Work is **uniform in shape** (every task has a name, a division, a questionnaire, claimant slots, a status, a message thread) but **varies in what it asks for** (a Writing task's questionnaire is one Detail-Text box; an Art task's is one Attachment; a Testing task's is a custom set). Identity, roles, divisions, teams, and the permission matrix are all data, not code — admins configure who can do what without a code change. A centralized Cedar-based access engine evaluates every gated action through one pipeline. Discord integration is optional and isolated; it can populate roles via sync but is never part of the auth path.

The build is organized as **eight ordered, full-stack vertical slices** (`docs/slices/00-overview.md` is the index), each one ending in a runnable, testable demo. Slices 1–7 ship v1; Slice 8 (Discord) is post-v1. The cross-cutting design is in `docs/ARCHITECTURE.md`; the domain language is in `CONTEXT-MAP.md`, `api/CONTEXT.md`, and `web/CONTEXT.md`.

## User Stories

### Bootstrap & first-deploy
1. As an operator standing up Patrice for the first time, I want the API to print a one-time **Bootstrap Key** to stdout when no **Effective Admin** exists, so that I can register the first admin without manual DB tampering.
2. As the first-ever user, I want to register via the Bootstrap Key through the normal invitation flow, so that the first admin is created the same way every later user is.
3. As the first admin, I want my email auto-verified at bootstrap so that a misconfigured SMTP doesn't lock me out of my own deployment.
4. As an operator, I want re-running the API after losing every Effective Admin to mint a fresh Bootstrap Key, so that "we deleted the last admin" is a recoverable state, not a redeploy.

### Identity & authentication
5. As a user, I want to log in with my email and password, so that I have a stable identity in Patrice.
6. As a user, I want my session held in an httpOnly cookie that survives page refreshes but expires reasonably, so that I'm not perpetually logged in nor constantly logged out.
7. As a user, I want a "verify your email" link sent to me, so that I prove I own the address I registered with.
8. As an admin operating a stricter org, I want to require email verification before users can log in at all (`requireVerifiedEmailToLogIn`), so that I have a stronger identity guarantee than soft "you have the link."
9. As a user, I want to reset my password through a single-use email link, and have that reset invalidate all my current sessions, so that "I had to reset" is treated as a doubt event.
10. As an admin, I want my action of granting/revoking a role to take effect on the user's very next request, so that I never have to ask anyone to log out and back in.

### Invitations
11. As an admin, I want to mint a single-use invite link, optionally pre-assigning a role bounded by what I myself may grant, so that I can onboard people with the right starting permissions and not exceed my own authority.
12. As an admin, I want a default 7-day expiry on invitations, so that abandoned invites don't accumulate as a security tail.
13. As an admin, I want to revoke a pending invitation, so that a leaked link can be killed.
14. As an admin, I want every invite redemption to be auditable (who, when, into what account), so that I can trace account provenance after the fact.
15. As an admin, I want pending invites I issued to be auto-revoked when I retire (the irreversible case), but to remain dormant if I'm only deactivated (reversible), so that the system reflects whether my authority will return.

### Roles & memberships
16. As an admin, I want to create roles — division-inherent, team-inherent, or standalone-functional — so that the **Action** vocabulary attaches to roles that match how the org thinks.
17. As an admin, I want creating a division to automatically create its inherent role, so that membership-via-role-holding is the structural truth and I don't have to remember to wire it.
18. As an admin, I want a single permission matrix editor (role × action grid with scope pickers) so that I can author "who may do what" without writing code.
19. As an admin, I want my grants on inherent division/team roles to automatically scope to that division/team, so that "the Writing Lead reviews Writing" is the natural shape, not a hand-wired exception.
20. As an admin, I want grant scopes for "all divisions I'm a member of" (the `own_group` Scope Shape), so that a standalone Cross-Division Lead role works without enumerating every division I'd ever join.
21. As an admin, I want to scope `user:grant_role`/`user:revoke_role` by which role is being granted (the `role` Scope Shape), so that I can let a Writing Lead grant the Writing inherent role without letting them grant Admin.
22. As the last **Effective Admin**, I want any operation that would leave Patrice with zero Effective Admins refused with a `409 LAST_ADMIN`, so that misconfiguration during a busy day can't lock out everyone.

### Divisions & teams
23. As an admin, I want each division to carry its own default questionnaire, default opening count, and an "openings-locked" flag, so that the unique shape of each division's work lives as configuration.
24. As an admin, I want pure-coordination divisions (no questionnaire) to exist for things like Leadership where there's no submissive work, so that the structure doesn't force a sham questionnaire.
25. As an admin, I want **Claim Eligibility AND-Composition** — both `division.restrict_claims` and `team.restrict_claims` must pass — so that I can enforce "only Writing members can claim Writing tasks" cleanly.
26. As an admin, I want teams as a loose, content-facing grouping (e.g. "USA Team") that may also restrict claims, so that subdivisions or content-bound responsibilities are first-class.

### Questionnaires
27. As an admin, I want to author a division's questionnaire from seven question types (Detail Text, Multiline, Text, Numeric, Dropdown, Radio, Attachment) with per-type constraints, so that art's questionnaire is "one attachment" and testing's is a custom form.
28. As an admin, I want zero-question questionnaires to be valid, so that I can explicitly create coordination-only divisions without ambiguity.
29. As a requester, I want my task to receive its own deep-copy of the division's questionnaire at creation time, so that editing the division default later never mutates my in-flight task.
30. As a requester (on tasks where my division allows it), I want to customize my task's questionnaire copy until the first submission lands, so that ad-hoc testing forms are possible.
31. As a requester, I want the questionnaire to lock once any submission exists, so that mid-flight requirement changes can't orphan answers.

### Tasks & claiming
32. As a requester, I want to create a task by picking a division (required), an optional team, a name, a markdown description, so that the task carries the right context and inherits the division's questionnaire copy + opening count.
33. As a claimant, I want to claim an open slot on a task that I'm eligible for, so that I commit to the work.
34. As a claimant, I want to leave a task I claimed but haven't submitted, freeing the slot, so that I can withdraw without permanent consequence.
35. As a claimant, I want my slot to stay consumed once I've submitted, so that the task tracks who actually attempted the work.
36. As a requester, I want to add openings, close the task to new claims, and change the requester, so that I can adjust capacity and ownership mid-flight.
37. As a requester, I want to be told "no, you can't change division/team after creation" so that I don't accidentally invalidate the questionnaire copy or claim eligibility.
38. As a user browsing tasks, I want to filter by division, team, status, claimant, or requester, so that I can find what I care about across a 100k-task population.
39. As a user paginating through a long task list, I want keyset/cursor pagination, so that newly-created tasks don't shuffle my page boundaries.

### Submissions, review, status
40. As a claimant, I want to submit my answers (validated against the questionnaire), so that I can hand over my work.
41. As a claimant, I want submission validation to enforce "every required answered, each within its type+constraints, attachments of the right type," so that I get fast feedback before review.
42. As a requester, I want to review each submission with approve / return / reject, with an optional comment, so that I can drive iteration with named decisions.
43. As a claimant whose submission was returned, I want to resubmit a new version (incrementing the **Submission Number**), with the prior conversation preserved scoped to the prior version, so that revisions stay legible.
44. As a requester reviewing a multi-claimant task, I want rejected submissions excluded from the **Status Min-Rule** but still visible in audit, so that "two approved, one rejected" can naturally land at Approved.
45. As a requester whose task has every claimant rejected or no Counted Slots, I want the **Empty Contributing Set Floor** to keep the task at Claimed (not vacuously Approved), so that I'm forced to explicitly act — complete, retire, free slots, or add openings.
46. As a requester, I want a **Manual Complete** action that approves the task regardless of submission states, so that I can close out coordination-only or genuinely stuck work.
47. As a requester or admin, I want `task:retire_submission` to require a non-empty reason and leave a task-level audit message that survives submission GC, so that "I scrubbed your work" is always accountable.
48. As the org admin, I want a per-org switch (`selfReviewAllowed`) for whether self-review (requester == claimant) is allowed, so that organizations that want strict separation can enforce it and others can let solo workflows happen.

### Messages, threads, attachments
49. As a user, I want to post markdown comments on a task and attach files, so that conversation happens in-context.
50. As a user, I want to reply to a comment, one level deep, so that conversations have shape but don't fork uncontrollably.
51. As a user, I want to edit and (soft-)retire my own messages, so that I can fix typos and remove stuff I posted in error.
52. As a user reviewing a submission, I want system messages to thread under the submission's "X submitted v{n}" message, so that the review conversation is scoped to that version.
53. As a user, I want to upload attachments (within content-type and size limits) and reference them from messages or submission answers, so that art deliverables, log files, and reference images are first-class.

### Notifications
54. As a user, I want a notification when a task I requested gets a submission, when a submission I made is reviewed, when someone replies in my thread, and so on — per the fixed matrix in `docs/slices/06-notifications.md`, so that I know when to look.
55. As a user, I never want a notification about my own action, so that the badge isn't noisy with my own clicks.
56. As a user with the app open, I want notification updates to arrive live (SSE) without refresh, so that the badge is current.
57. As a user reconnecting after a network blip, I want to pull missed notifications from the durable table, so that the SSE drop didn't cost me awareness.
58. As a user, I want to mark notifications read individually or all-at-once, so that I can clear my queue.

### Retirement, revive, GC
59. As an admin, I want to retire any core entity (task, division, team, role, user, message, attachment), so that the lifecycle is uniform and I'm not memorizing per-entity deletion semantics.
60. As an admin, I want every **Retire**d entity's grants to go inert via **Retired-as-Hard-Deny**, so that "retired" is a security primitive, not just a label.
61. As an admin, I want a configurable **Grace Period** during which I can revive a retired entity, so that an accidental retirement isn't permanent.
62. As an admin, I want **Revive** to be a separately-granted action per entity type (not implicit-from-retire), so that I can let leads retire their own area but only admins can revive.
63. As an admin, I want fully-retired users (post-grace) to be **Scrub-in-Place**'d — PII purged, the row preserved with a tombstone so authored history still resolves — so that GDPR-style erasure and audit coexist.
64. As an admin, I want a per-org `anonymizeLabel` flag so that I can decide whether scrubbed users render as their last display name or a generic "Former member."
65. As an admin, I want the GC sweep to delete only past-grace, unreferenced entities, with `ON DELETE RESTRICT` as the DB backstop, so that a logic bug fails the delete instead of corrupting state.
66. As an admin, I want a "run sweep now" tool and a dry-run mode, so that I can exercise GC during ops.
67. As an admin, I want activity payloads to contain IDs only (**Activity Payload Discipline**) so that scrubbing users doesn't require also retroactively scrubbing the audit log.

### Discord (post-v1)
68. As an admin, I want to connect a Discord guild as an integration, with config separate from any current/future provider, so that Patrice's data model is provider-agnostic from day one.
69. As a user, I want to link my Discord account to my Patrice user explicitly, so that the mapping is consensual.
70. As an admin, I want to map a Patrice role to a Discord role (by stable Discord snowflake) and choose sync direction (inbound/outbound/bidirectional), so that membership flows the way the org wants.
71. As an admin, I want auth to keep working even if Discord is down, broken, or never set up, so that the auth path never depends on integration health.
72. As an admin, I want sync conflicts resolved by last-write-wins on `updated_at`, so that the precedence rule is predictable.

### Cross-cutting / admin
73. As an admin, I want every config write (role, division, team, grant, settings, retirement) recorded in the activity log with an `actor_user_id` and a structured payload, so that auditability is by-construction.
74. As an admin, I want errors to carry a stable JSON `{code, message, details?}` shape so that the Angular client can present specific user-facing copy per code.
75. As an operator, I want all times stored and surfaced as server-authoritative UTC, so that client clock drift doesn't desync ordering.
76. As an operator, I want the API to assume it sits behind a reverse proxy terminating TLS, so that the self-host path is straightforward.
77. As a self-hosting operator, I want the local-filesystem attachment driver to work without S3, so that small deployments don't need object-storage infrastructure.

## Implementation Decisions

The design source of truth is `docs/ARCHITECTURE.md`; the per-slice build plan is `docs/slices/00-overview.md` (index) through `docs/slices/08-integrations-discord.md`. Load-bearing API-tier terms are defined in `api/CONTEXT.md`. The decisions below are the project-level cross-cuts every slice depends on; per-slice schemas, endpoints, and Cedar wiring live in the slice files.

### Topology and stack (pinned)
- **Three strictly-bound tiers**: Web (Angular, signals-first, OnPush, standalone components, OpenAPI-generated client) → API (NestJS + TypeScript, ports-&-adapters, Zod at boundary, OpenAPI emitted from Zod) → Database (Postgres 16+ single-node, Prisma + Prisma Migrate, UUIDv7 PKs).
- **Single-instance API for v1**, with documented seams for HA later: `PubSubPort` for SSE fan-out (in-process adapter v1; Postgres LISTEN/NOTIFY adapter post-v1), **Config Version** read fresh from DB per request, GC sweep uses pg-boss `singletonKey`, partial unique index keeps the bootstrap system invitation singular even under concurrent boot, local-fs object-storage driver is single-instance-only.
- **Auth hashing**: argon2 for passwords; SHA-256 + startup pepper for tokens.
- **Access engine**: Cedar via `@cedar-policy/cedar-wasm`. Grants project as template-link policies; the projector also emits a small set of static + conditional-static policies (**Retired-as-Hard-Deny**, **Baseline Self-Access**, the self-review forbid when `selfReviewAllowed=false`). Inputs cached per-request; cache key is **Config Version**, read fresh per request.
- **Background work**: pg-boss (Postgres-backed). Outbound email, GC sweep, and (post-v1) integration sync run as jobs.
- **Notifications transport**: SSE; the stream is a thin "go sync" signal; durability lives in the `notification` table; client reconciles on connect/reconnect.
- **Email**: SMTP via nodemailer.
- **Object storage**: S3-compatible (production default) or local-fs (single-instance self-host) behind the same port.

### Domain model
- **Roles** are the authorization atom (unrelated to Discord roles). Two flavors: **inherent** (1:1 with a division or team — holding it *is* membership; its grants are pinned to that group) and **standalone** (e.g. Org Admin). Users may hold multiple roles; grants accumulate.
- **Tasks** are uniform in shape; what varies is the questionnaire and its submissions. Every task has a required division, an optional team, a requester, openings, a markdown description, a questionnaire (its own copy), claimants, submissions, a derived status, a message thread.
- **Status** is a fixed derived enum (`Open → Claimed → Review ⇄ Revising → Approved`) — carried per-submission, with the task's status the lowest among **Counted Slots**, ordered by the **Status Min-Rule**. **A task is Approved only when (a) every counted slot is Approved AND (b) ≥1 counted Approved slot exists.** Empty contributing set ⇒ **Empty Contributing Set Floor** ⇒ `status_cache='claimed'`. No vacuous-truth Approval.
- **Questionnaires** have seven question types — Detail Text, Multiline, Text, Numeric, Dropdown, Radio, Attachment — each with constraints. Validation is a pure function `validateSubmission(questionnaire, answers, attachmentLookup) → ok | errors[]`, port-injected for attachment lookup, reused server-side and in Angular.
- **Questionnaire ownership is schema-enforced and exclusive**: `questionnaire.owner_division_id` and `owner_task_id` are mutually exclusive UNIQUEs with a CHECK ensuring exactly one is non-null. The architecture's "editing a division default never mutates existing tasks" invariant rests on this; the schema is the backstop.
- **Submissions** are versioned per-claimant via **Submission Number** (`submission_no`, part of the row's identity) — distinct from the global `version` column used for optimistic locking.
- **Messages** are one-level threadable. A submission's events emit a top-level system message; review/comment messages are replies under it. Resubmission creates a new top-level message; old threads stay open but UI emphasis shifts.

### Authorization vocabulary (closed, code-defined)
The fixed `resource:verb` **Action** set is in `docs/ARCHITECTURE.md §2.3` and `docs/slices/02-org-configuration.md`. Highlights of the project-level rules:
- **Closed vocabulary**: admins may *grant* actions but never invent them.
- **Read/view is not gated in v1.** No `read`/`view` action exists; the access vocabulary is write-only. View-permissioning is wishlisted (`docs/ARCHITECTURE.md §6.2`).
- **`revive` is a distinct, separately-granted action per resource** — not an implicit corollary of `retire`. Admin holds the full set by default; delegating narrower revive authority is an explicit matrix edit. `user:reactivate` is the deactivation-reversal arrow (in-life, reversible) — distinct from `user:revive` (post-retirement, pre-GC).
- **Effective Admin** is the load-bearing predicate defined in `docs/slices/00-overview.md`'s glossary (and `api/CONTEXT.md`): ≥1 active user with at least one `permit` grant for one of `{grant:create/update/retire, role:create/update/retire}` at `scope_kind='global'`.
- **Scope Shape** has five values — `global`, `specific_group` (`specific_division`/`specific_team`), `own_group` (`own_division`/`own_team`, evaluated against principal's membership set), `own` (per-resource owner relation; the projector picks the right Own Family template per action), `role` (for `grant_role`/`revoke_role`).
- **Cedar owns policy logic.** Reach for TS guards only for the two named exceptions architecture calls out: the administrability invariant (Cedar can't reason about "is an admin path still left") and the submission state-machine transition guard (structural, not who-may).

### Identity, sessions, invitations
- **Account creation is invite-only**; there is no open sign-up endpoint. Invitations carry pre-assigned roles bounded by the issuer's grantable set, re-validated at redemption. Tokens are CSPRNG nanoid, stored hashed; redemption is POST-only (anti-unfurl), atomic FCFS, default 7-day expiry.
- **Invitation status is derived on read** from `revoked_at`, `use_count`, `expires_at` — no stored status column, no sweep to flip `pending → expired`.
- **Pending-invite issuer policy**: passive on deactivation (rely on redemption-time re-validation); proactive auto-revoke on retirement (irreversible); bootstrap invites (`created_by IS NULL`) immune.
- **Email verification** is identity-level (`user_identity.verified_at`); Google identities start verified; bootstrap auto-verifies. Per-org `requireVerifiedEmailToLogIn` gates login; flag flips don't invalidate existing sessions. `password-reset/confirm` requires `verified_at IS NOT NULL` regardless of the flag.
- **Sessions** are stateful, identity-only (never cache permissions; permissions resolve per request), held in httpOnly + Secure + SameSite cookies, with absolute + sliding expiry from org settings.

### Retirement, revive, GC
- **Three states: Active → Retired → Deleted.** **Retire** is soft (`lifecycle_state`/`retired_at`); GC is a periodic pg-boss job (long cadence) that deletes only past-**Grace Period** unreferenced entities, with `ON DELETE RESTRICT` as the DB backstop and orphaned-blob reconciliation for object storage.
- **Task is a composite aggregate** that GCs as a unit (task + messages + submissions + answers + claimant slots + attachments). The `activity` table is never a refcount and never GCs with an aggregate.
- **User Scrub-in-Place** preserves the row's `id` + `display_name` (as tombstone label), purges PII/satellites (`user_identity`, `external_identity`, `session`, `auth_token`, `notification`, `user_role`), and auto-revokes pending invitations the user issued. Per-org `anonymizeLabel` renders as "Former member" when set.

### Activity & audit
- **`activity` table** lands in Slice 1 (load-bearing for invitation + config audit there onward).
- **Activity Payload Discipline**: payload contains **IDs only — never PII strings**. PII rendering is by join-to-current-state with tombstone fallback. Sidesteps the audit-immutability-vs-data-erasure conflict.
- **Per-slice verb catalog** is documented inside each slice file as it's introduced.

### Settings as a structured surface
- **`organization.settings`** is a Zod-typed structured payload, edited via `PATCH /config` (gated by `config:update`). Flags in v1: `requireVerifiedEmailToLogIn`, `selfReviewAllowed`, `anonymizeLabel`, session lifetimes. Flipping `selfReviewAllowed` patches the Cedar policy set; flipping login-verification flags only affects new logins.

### API conventions
- **REST + OpenAPI** (decided), code-first via Zod, emitted as the contract.
- **Keyset/cursor pagination** (UUIDv7 PK doubles as the default-order cursor; other sorts use `(sortKey, id)`).
- **Faceted, typed query parameters** — each backed by an index, AND-combined, with `in:` multi-value support. No arbitrary boolean DSL. No free-text search in v1.
- **PATCH endpoints accept only pure metadata.** Lifecycle, authority, and aggregate-structure changes go through named action endpoints. Silent-ignore on unknown fields is forbidden — PATCH returns 422.
- **Error envelope**: `{ error: { code, message, details? } }`. `403` denials, `401` unauthenticated, `422` validation, `409` optimistic-lock or state-machine conflicts.

## Testing Decisions

A good test for this project verifies an actor's observable outcome — a session is created, a notification row exists, a Cedar decision goes deny when retired — and never inspects implementation detail (Prisma row internals, controller signatures, Cedar template shapes). Tests should fail when behavior changes and survive refactors that preserve behavior.

### One primary seam, three narrow unit seams

**Primary: HTTP API integration.** Every slice's acceptance demo and test list reads in HTTP terms (POST /invitations, claim a task, submit answers, observe status). Integration tests run the real Nest app against a Testcontainers Postgres + the real Cedar projector + the real pg-boss queue. Supertest-style requests; assertions on response code, JSON body, and follow-up GETs. One seam, broad coverage.

**Unit seam 1: Cedar policy correctness.** The matrix is combinatorial and the riskiest component (`docs/ARCHITECTURE.md §6.3`); HTTP-level coverage can't enumerate it. Unit-test the projected policy set against synthetic principal/resource/action tuples — own-vs-other, scoped-vs-global, retired forbids overriding permits, self-review forbid presence vs. absence, Baseline Self-Access, last-admin refusal sources. The test harness loads the same template library and projector that production uses.

**Unit seam 2: `validateSubmission` pure function.** `(questionnaire, answers, attachmentLookup) → ok | errors[]` is pure and reused by Slices 3 and 5. Test directly with synthetic question shapes and answer payloads — required-missing, numeric-out-of-range, wrong attachment type, happy path. Attachment lookup is the injected port; tests stub it.

**Unit seam 3: Status Min-Rule recompute.** Pure function over claimant slot states. Test the ordering (`open < claimed < revising < review < approved`), the rejected-exclusion, the closed-unfilled-exclusion, and the Empty Contributing Set Floor (Q8 of the grilling — `claimed` fallback). Easy to exercise; hard to cover comprehensively via HTTP setup.

### Test framework choices

To be made when Slice 1 is built. Suggested defaults: **Vitest** (or Jest if Nest's tooling pushes that way) for both unit and integration; **Testcontainers** for Postgres; **supertest** for HTTP-level assertions; **pg-boss** in synchronous mode for jobs under test. Recorded as Slice 1's first ADR when chosen.

### Prior art

None in this repo — Patrice is greenfield. Slice 1's tests establish the patterns subsequent slices follow. Each slice file already names its required test cases.

## Out of Scope

The following are explicitly deferred to post-v1 and tracked in `docs/ARCHITECTURE.md §6`:

- **Read/view permissioning.** v1 vocabulary is write-only.
- **Bulk visibility predicates** (per-row view filtering as SQL predicates). Tabled — minor need for our uses.
- **State-conditional permissions** (action allowed depending on task status).
- **User merge/combine** (merging duplicate accounts).
- **Free-text search** over names/descriptions/answers. v1 ships faceted filtering only; FTS deferred.
- **Self-registration beyond invitations.**
- **Service tokens / API keys** for programmatic callers.
- **Inter-task relationships** (parent/child, dependencies).
- **Sync deletion-propagation and live multi-integration** (Discord itself is post-v1, Slice 8).
- **`activity` table partitioning** (retention strategy).
- **2FA / MFA** for the account system.
- **Invite ↔ verified-email binding** (the prevention upgrade — email verification itself is v1).
- **Multi-instance API deployment.** Seams are in place; the LISTEN/NOTIFY pub/sub adapter is post-v1.
- **Reusable saved questionnaires** beyond division defaults.
- **Editing a questionnaire after a submission exists.** v1 is locked-at-first-submission.
- **Self-service recovery** from a lost sole external auth method.
- **Frontend design-system / component-library** choice (Angular Material vs. headless+custom).
- **Rate-limiting**, **upload safety/scanning**, **audit-log tamper-resistance**, **session-doubt signal catalog**.
- **Observability & testing strategy** beyond what each slice's test list specifies.
- **Migration tooling from the legacy Google Drive sheets** — migration is handled externally; Patrice provides no import in v1.

## Further Notes

- **Build is slice-ordered.** Each of Slices 1–7 is a runnable, testable demo and the gate to start the next is "prior slice's tests are green." Slice 8 (Discord) is post-v1 and only built after v1 ships.
- **`/to-issues` should split each slice into its implementation issues.** Natural sub-issues per slice: schema migration, Cedar wiring (if applicable), API endpoints, Angular surface, tests. Each issue should be self-contained enough that a fresh agent can pick it up with just this PRD + the issue body, per `/implement` flow.
- **Memory persisted from grilling.** A feedback memory at `~/.claude/projects/.../memory/feedback_cedar_owns_policy.md` records the "Cedar owns policy logic" principle. Future grilling/code review on this project should honor it.
- **The slice files are the implementation contract.** This PRD captures cross-cutting decisions and provides the project-level user-story surface; per-issue implementation specs come from the slices.
- **Domain glossary** lives in `api/CONTEXT.md` (load-bearing terms, ~18 of them across Authorization / Task Lifecycle / Identity & Bootstrap / Entity Lifecycle / Cross-cutting) and `web/CONTEXT.md` (thin, UX-specific). `CONTEXT-MAP.md` is the index.
