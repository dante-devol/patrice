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
A `user_identity` row with `verified_at IS NOT NULL`. Google identities start verified; password identities verify via the email-token flow. Bootstrap auto-verifies regardless of the org's verification policy.
_Avoid_: Confirmed Email, Validated Account

### Entity lifecycle

**Retire**:
The soft-delete action — sets `lifecycle_state='retired'` and `retired_at=now()`. Distinct from **Revive** (the reverse, during grace), **Reactivate** (the reverse of **Deactivate** — in-life, reversible), and **GC** (the permanent collector). Each `*:revive` is its own separately-granted Action, not an implicit corollary of `*:retire`.
_Avoid_: Delete, Soft-Delete, Archive

**Grace Period**:
The configurable window after `retired_at` during which Revive is allowed and GC will not collect. Recovers from accidental retirement.
_Avoid_: Retention Window, Soft-Delete TTL

**Scrub-in-Place**:
The permanent user-erasure operation. Keeps the `app_user` row (preserving FK validity) with `id` + `display_name` only; purges PII and satellites; auto-revokes invitations the user issued. Patrice's GDPR-style erasure path.
_Avoid_: User Deletion, Account Removal

### Cross-cutting

**Config Version**:
The monotonic `organization.config_version` counter that bumps on any role/grant/retirement/settings change. The Cedar input cache keys on it; the column itself is read fresh from DB per request (the inputs it keys are cached, the key is not).
_Avoid_: Cache Generation, Schema Version

**Activity Payload Discipline**:
The rule that `activity.payload jsonb` contains **IDs only** — never PII strings. Sidesteps the audit-immutability-vs-data-erasure conflict; the `logActivity` helper Zod-validates per-verb to enforce it.
_Avoid_: Audit Privacy Rule

**Claim Eligibility AND-Composition**:
The rule that `division.restrict_claims` and `team.restrict_claims` are AND-composed: if either is true the claimant must hold the corresponding inherent role. Evaluated in Cedar via the `task:assign @ own_as_claimant` template; reads `principal.memberDivisions` and `principal.memberTeams`.
_Avoid_: Membership Check, Eligibility Rule
