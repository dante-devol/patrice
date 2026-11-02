# Patrice — Architecture & Design

> **Status:** Living design artifact. The **Design Goals** section captures *what*
> Patrice should do (product, UX, API surface). The per-tier sections (**Web**, **API**,
> **Database**) capture *how* — these now carry **committed decisions** (Web = Angular,
> DB = a full schema mapping, API = TypeScript + Cedar) alongside still-open research,
> each marked as such. Outstanding decisions are consolidated in **§6 Need-to-Address**.

## Guiding context

These hold across every section unless explicitly overridden:

- **Single organization per deployment.** Each install of Patrice serves one
  organization. We keep an explicit `Organization`/workspace *seam* so this
  assumption lives in one place and could later widen to multi-org — but we do
  **not** build multi-tenancy now. The `Organization` is effectively a singleton
  row, still modeled as a real table.
- **Three strictly-bound services.** Patrice is a sequence of independent tiers
  with clear contracts between them, not one monolith:
  `Web (frontend) → API (middleware, + cache) → Database (+ ORM, object store)`.
  Each tier should be replaceable without rewriting its neighbors.
- **TypeScript, end to end.** Both code tiers (Web, API) are TypeScript. A future **Rust reimplementation
  is no longer a design driver** — our tooling has deliberately deepened TS-coupling
  (Cedar via its JS bindings, Prisma's TS schema/migrations), so a language swap would now
  mean replacing those: a *growing* cost for a *narrowing* benefit. The architecture this
  once motivated we **keep on independent merits**: **ports & adapters** (for tier
  boundaries + testability) and a **language-neutral OpenAPI contract** (for the strict
  Web↔API boundary + an explicit, versionable, external artifact). The contract's source of
  truth stays the **OpenAPI spec, never TS types** — TS may *implement* a tier but may not
  *be* the contract (so still no tRPC/shared-type coupling; §4.1).
- **Patrice is the source of truth; integrations are feeds.** Patrice owns its own
  users, roles, and memberships. It *can* sync bidirectionally with an integration
  (Discord) when configured, but never depends on one. Conflict precedence is
  configurable, defaulting to last-write-wins by timestamp regardless of source.
- **Auth and identity are strictly separated from integration machinery.** The
  email/password + Google authentication core never depends on any integration.
  Integration adapters are isolated modules — "integrations are utilized by Patrice, not
  coupled with" (Discord is the first such integration).
- **Roles are the central currency.** A Patrice **Role** (unrelated to Discord roles)
  is the authorization atom. A user may hold **multiple** roles. Each division and team
  owns an **inherent role** (1:1) whose possession *is* membership and whose grants are
  scoped to it; standalone functional roles (e.g. Org Admin) also exist. **Scope is
  carried at the grant level.** Permissions, memberships, and integration sync are all
  downstream of role configuration.
- **Patrice is a configurable task-tracking engine.** Almost everything that looks
  org-specific — roles, divisions, teams, division default questionnaires, the
  permission matrix, external group mappings, claimant openings — is **data/
  configuration**, not code. This organization's particulars are one *instance* of it.
- **One access-evaluation engine.** Every gated action — claiming, submitting, reviewing,
  editing, commenting, uploading, configuring — is evaluated by a single, centralized,
  MediaWiki-style permission pipeline. No bespoke per-feature access logic; "can submit"
  and "can review" follow the same evaluation path. (Read/view is not gated in v1, §2.3.)
  Expressiveness is confined to **cached policy resolution**; the per-request hot path
  stays cheap — resolve once per change, evaluate in-memory, filter lists at the query.
- **Permissions are enforced in the API tier.** The Database stores only the internal
  representation of facts; it never encodes "who may do what."
- **Retire, then reference-counted delete.** Core data is never deleted outright; it is
  *retired* and kept while any references remain, then garbage-collected once its
  reference count reaches zero. Retired data enters the access engine with a
  **forcefully unpermissive, non-configurable** permission set — it coexists with live
  data passively and surfaces as blocking errors the UI motivates users to resolve.
  There is **no separate rectification framework**; rectification emerges from
  "retired = denied."
- **Identity is distinct from face.** Tasks and most entities carry a stable **GUID** as
  their true identity; human-facing names/labels are mutable decoration over it.
- **Scale envelope.** Sizing target: **~200 users, ~100k tasks** (single org). This is
  comfortably **single-node Postgres** and grounds the "don't build it yet" calls (no
  mandatory Redis, caching deferred, bulk visibility tabled) — while making **pagination**
  a genuine need and the append-only **`activity` table** the one structure whose growth
  to watch (retention/partitioning, not sharding).
- **Single-instance API in v1; multi-instance seams in place.** v1 deployment is a
  single API process. The seams that would otherwise quietly break under HA are designed
  in now: a `PubSubPort` wraps SSE fan-out (in-process adapter; Postgres `LISTEN/NOTIFY`
  adapter post-v1); `organization.config_version` is **read fresh from the DB per request**
  (the inputs it keys are cached, the key is not); GC sweeps use pg-boss `singletonKey`;
  bootstrap-invitation creation uses a partial unique index so two-instance boot can't
  duplicate the system invite; and the **local-fs attachment driver is documented as
  single-instance-only** (multi-instance must use S3-compatible). HA becomes a deployment
  topology change, not a redesign.

---

## 1. Overview

*Scope: What Patrice is, who it serves, the high-level topology, and the
principles above made concrete. The orientation map for everything below.*

### 1.1 Purpose & summary
Patrice is a task-tracking tool for a single organization. It exists to **replace a
sprawling collection of ~20 Google Drive task-tracking documents** (hundreds of
entries each) with a single structured system. Work is contributed across **divisions**
(the kind of labor — Scripting, Writing, Art, Testing, Leadership, etc.) and organized
into **teams** (content-facing groups — e.g. a "USA" team). Members **request** tasks and
**claim** them; what a task *asks for and collects* (its **questionnaire**) differs by
division — writing submits text, art submits files, testing fills out a custom form. The
organization runs its development out of Discord, so Patrice optionally **syncs** identity
and role information with a Discord guild — without ever depending on it.

### 1.2 System topology
Three strictly-bound tiers with explicit contracts:

```
┌────────────┐   HTTP / API contract   ┌────────────────────┐   ORM / SQL   ┌──────────────┐
│    Web     │ ──────────────────────▶ │        API         │ ────────────▶ │   Database   │
│ (frontend) │ ◀────────────────────── │   (middleware)     │ ◀──────────── │  + object    │
└────────────┘                         │  • access engine   │               │    store     │
                                       │  • sessions        │               └──────────────┘
                                       │  • cache (read-shield)│
                                       │  • integration adapters ├─▶ queue ─▶ ext. providers
                                       └────────────────────┘
```

- The **API** is the only tier that talks to the Database and the only tier that
  enforces permissions, via a single centralized access engine.
- **Integration adapters** (Discord first) live behind the API as **outlets on a message
  queue** — sync work is enqueued and consumed asynchronously, keeping each isolated and
  resilient to provider outages.
- *Diagram is indicative; tier-internal choices are deferred to sections 3–5.*

### 1.3 Non-goals
- **Not** a real-time chat/messaging app (task messages are async, best-effort ordered).
- **Not** multi-tenant SaaS (single org per deployment).
- **Not** Discord-first or Discord-dependent (integration is optional and isolated).
- **Not** an importer for the legacy Google Drive sheets — migration is handled
  externally; Patrice conceptually replaces them but provides no import tooling in v1.
- **Not** optimizing for a future Rust reimplementation — TypeScript end to end; the
  Rust-swap is deprioritized (Guiding Context, §4.2).

### Open Questions — Overview
- _(none yet)_

---

## 2. Design Goals

*Scope: The product, UX, and API-surface intent — the **what**, kept as independent of
implementation as is practical. A few items here unavoidably touch mechanism where product
behavior depends on it (session/cookie handling §2.11, optimistic-locking §2.10, the
permission-cache/version-stamp model §2.3); those are deliberate and called out in place.*

### 2.1 Domain model & glossary
The shared vocabulary every tier references. These are **conceptual** objects, not
table definitions. Every entity carries a stable **GUID** identity distinct from its
editable name/face.

| Concept | Definition |
|---|---|
| **Organization** | The singleton owner of all data and configuration. Has a name, zero or more **Integration Connections**, and holds org-level configuration (roles, divisions, teams, mappings, division default questionnaires & openings, the permission matrix). |
| **Integration Connection** | A configured link from the Organization to one external workspace of some **provider** (Discord first; the model is provider-agnostic and an org may hold several). A Discord connection's external workspace is a **Guild** (Discord's name for a server). |
| **User** | A Patrice-native identity: name, account/authentication details, the **Roles** they hold, and optional linked **external accounts** (e.g. Discord, one per connection). Created via **invitation** (2.2); starts as a minimal *base user* and is decorated with roles. |
| **Role** | The **authorization atom**, native to Patrice and unrelated to Discord roles. A user may hold **multiple** roles. Two flavors: an **inherent role** auto-bound 1:1 to a division or team (holding it *is* membership; its grants are scoped to that division/team), and **standalone/functional roles** (e.g. Org Admin) carrying global or explicitly-scoped grants. Discord roles map *onto* roles via config. |
| **Membership** | A user's belonging to a Division or Team — equivalent to holding that division/team's **inherent role** (1:1). Membership grants the division/team's scoped permissions. |
| **Division** | The core axis of labor (Writing, Art, Testing, Leadership…). Configurable. Owns an **inherent role** (membership), supplies a **default questionnaire** and **default openings** for its tasks (2.6), and acts as a **permission scope**. May be a pure grouping with no task work (e.g. Leadership). |
| **Team** | A loose, content-facing grouping (e.g. "USA", "3D Artist Team"). Owns an **inherent role** (membership); indicates responsible parties and *may* restrict who can claim its tasks. Subdivisions of a division are modeled as teams. |
| **External group mapping** | A configured relationship between a Patrice **Role** and an external group (e.g. a Discord role) within an Integration Connection, defined in Patrice config and associated by the provider's **stable group ID** (not name) for resilience. Sync-capable, bidirectional. |
| **Permission / Policy** | A rule governing an **action** (a `resource:verb`; §2.3). Attaches to roles; some **global**, some **scoped** (evaluated relative to the target's division/team, ownership, or granted role). Evaluated by the single access engine in the API tier. (No read/view action in v1.) |
| **Task** | The unit of tracked work — **uniform in shape**. Has a GUID + editable name, a required **Division**, an optional **Team**, a requesting User, a markdown **description**, **claimant slots** (openings), a **Questionnaire**, a derived **status**, timestamps, and a **message** thread. (2.5/2.6.) |
| **Questionnaire** | The structured "ask" every task carries — an ordered list of typed **Questions**. Seeded from the division's default (writing → one text box; art → one attachment); **testing** requesters customize per-task. Locked once any submission exists. (2.6.) |
| **Question** | One questionnaire prompt of a fixed **type** (Detail-Text · Multiline · Text · Numeric · Dropdown · Radio · Attachment) with **qualities** (char limit, numeric range, options, allowed filetypes, required). (2.6.) |
| **Submission** | A claimant's **answers to the questionnaire** (each answer scalar or a resource). One per claimant, **versioned** (resubmission = new version). Carries the per-submission review status. (2.6.) |
| **Status** | A **derived lifecycle state** — the fixed enum `Open · Claimed · Review · Revising · Approved` (§2.5). Carried by **submissions**; a **task's status = the lowest among its claimant slots**. Non-editable; advanced by `task:submit`/`review` and slot changes. |
| **Message** | An entry in a task's thread — either a **user comment** (sender, markdown, attachments) or a **system message** (senderless audit/notification source, e.g. "X submitted", "Y reviewed"). **One-level threadable**: only top-level messages host threads. |
| **Attachment** | A file referenced by a **message** or a **submission answer** (Attachment-type question) — image, text, audio/music, model file, etc. Hosted in object/blob storage. |
| **Invitation** | A bearer-token link (`<site>/invite/<token>`) that resolves to a new base user on redemption — the account-creation path (§2.13). Single-use/FCFS in v1, expiring, with privilege-bounded pre-assigned roles; bootstrap is a passcode-gated system invite. |
| **Activity / Event** | The **org-level** immutable audit log — **configuration changes** and **sync events** (including external-group removals). *(Task timelines live in the task's **messages**, not here; notifications are *generated from* messages, §2.12.)* |

### 2.2 Identity, Accounts & Authentication
- **Native identity, integration-independent.** Patrice owns users; authentication
  never depends on **any** integration (Discord included).
- **Canonical identity & reconciliation.** The `app_user` (UUID) is the **sole canonical
  identity**; email, Google `sub`, and external ids are **links/attributes**, never the
  identity. **Creation is invite/bootstrap-only** — an auth flow that matches no existing
  link is **rejected, never auto-provisioned** (no invite ⇒ no account), which structurally
  prevents duplicate accounts. Extra auth methods / external accounts are **linked** to an
  existing user via an explicit, authenticated action; `(provider, subject)` uniqueness
  stops one external account attaching to two users. **Email is a contact attribute** (unique
  per org), *not* the join key — so an invite email and a Google email needn't match.
  *(Email **verification** itself — confirming you own the address — is a v1 flow, below.
  What's deferred is binding an **invite** to a verified email for redemption-prevention
  (§2.13/§6.2). Recovery from a lost sole-auth-method is admin-assisted re-invite/attach plus
  password reset — §6.4.)*
- **Auth methods:** email/password and Google OAuth (primary). Discord login is a
  possible future method, not a v1 requirement.
- **Provisioning is invitation-first (v1):** a unique invitation resolves to a minimal
  **base user** who can do little until configured. Roles are then granted either by an
  **admin** ("decoration") or by the user via an **integration point** (e.g. linking
  Discord to populate roles from mapped Discord roles).
- **Invitations** are the account-creation path — see the dedicated treatment in **§2.13**
  (bearer-token model, single-use/FCFS, expiry, privilege-bounded pre-assigned roles,
  POST-only redemption, audit, and the passcode/bootstrap tie-in).
- **Password/email mechanics:** email-password auth implies **email verification** and a
  **password-reset** flow. A successful reset is a "doubt" event that **invalidates the
  user's existing sessions** (§2.11). Both flows require an **outbound-email capability** —
  a real infrastructure dependency (SMTP/provider) — see the dispatch home in §4.5 and the
  infra-seam blocker in §6.1.
- **Verification policy is configurable** via `organization.settings.requireVerifiedEmailToLogIn`
  (default `false` = verify-after-session). When true, login rejects unverified password
  identities with `403 EMAIL_NOT_VERIFIED`; flag flips do not invalidate existing sessions.
  **Bootstrap auto-verifies the first identity unconditionally** (brick-on-SMTP-broken risk
  outranks the flag). **Always-on, regardless of flag:** `POST /auth/password-reset/confirm`
  requires `verified_at IS NOT NULL` (closes the unverified-email account-hijack-via-reset
  path).
- **Discord linking** is *configuration-optional* — for this organization it is, in
  practice, how most users populate their roles, but Patrice never requires it.

### 2.3 Authorization & Permissions
- **One engine, in the API tier.** Inspired by MediaWiki: an **expressive, finite**
  permission system where **every gated operation is an action** routed through a single
  evaluation pipeline. "Who may claim" and "who may retire" are configurable behaviors on
  the same logical path, never separated in code. *(Read/view is **not** gated in v1 — see
  the vocabulary below; view-permissioning is wishlisted, §6.2.)*
- **Permissions attach to Roles; scope is carried at the grant level.** Some grants are
  **global**; some are **scoped** to a division/team (an inherent role's grants are
  scoped to its own division/team). A user holds multiple roles; grants accumulate.
- **Retired data is a hard deny.** Entities that have been retired (2.10) enter the
  pipeline with a forcefully unpermissive, non-configurable permission set, regardless
  of the actor's roles.
- **Baseline self-access is a global grant.** A user's access to *themselves* — own
  profile, own session list, own claimed/requested tasks — is conferred globally, **never**
  through a division/team-scoped role. This guarantees a retired or inert role can never
  lock a user out of their own account (see §2.10).
- **Admin tiers exist globally and per-division** (a Writing admin ≠ an Art admin),
  both expressed as roles with the appropriate grants.
- **Cheap despite expressive.** The hot path stays fast by caching the engine's **inputs**,
  not by us doing Cedar's work: (1) the **Cedar policy set** (the projected matrix) and the
  **actor's role entities** are **cached and version-stamped** — rebuilt only on a
  role/config/retirement change (immediate, not per-request); (2) **Cedar resolves + decides**
  per request over those cached inputs — sub-millisecond on bounded inputs; (3) **bulk
  visibility** (per-row view filtering) would compile to **query predicates**, but is
  **tabled** — a minor need for our uses. Revisit only if it becomes one.
- **v1 scope:** role/scope-based only. **State-conditional** permissions (action
  allowed depending on task status) are a noted **future interest**.
- **Action vocabulary — `resource:verb`, closed & code-defined.** Patrice ships a fixed
  action set; admins configure *who may do which* (grants), but **cannot invent actions**.
  Verbs follow **CRUD-minus-Read**: `create` / `update` / `retire` (retire = our lifecycle
  "delete"; **no `read`/`view`** action — view-permissioning is wishlisted, §6.2). Beyond
  CRUD, an action gets a **face** — its own verb — when editing one field needs *different
  authority* than the object's general `update` (a user's name vs. their roles).
  Scope tags: **G** global · **S** scopable to a division/team · **O** ownership-scopable
  (actor authored/requested/owns the target; `own` is a `scope_kind`, §5.3).

  | Resource | Base (create / update / retire / revive) | Faces |
  |---|---|---|
  | `task` | `create`(S) · `update`(S,O) · `retire`(S,O — withdraw) · `revive`(S,O) | `assign`(S,O — own=claim/leave) · `submit`(S,O — own=claimant) · `review`(S,O — own=requester: approve/return/reject a **submission**) · `retire_submission`(S,O — requires `reason`) · `complete`(S,O — own=requester, manual bypass) · `configure_questionnaire`(S,O — own=requester) · `manage_claims`(S,O — openings & close-to-claims) · `change_requester`(S,O) |
  | `message` | `create`(S) · `update`(O,S) · `retire`(O,S) · `revive`(O,S) | — |
  | `attachment` | `create`(upload, S) · `retire`(O,S) · `revive`(O,S) | — |
  | `user` | `update`(profile/name, G) · `retire`(G) · `revive`(G) | `deactivate`(G) · `reactivate`(G) · `grant_role` · `revoke_role` — last two **scoped by the granted role** |
  | `session` | — | `revoke`(G, O — own = the session's user) |
  | `invite` | `create`(S) · `retire`(revoke, S) | — |
  | `role` | `create`(G) · `update`(G) · `retire`(G) · `revive`(G) | — |
  | `division` | `create`(G) · `update`(S — incl. default questionnaire & openings) · `retire`(G) · `revive`(G) | — |
  | `team` | `create`(S) · `update`(S) · `retire`(S) · `revive`(S) | — |
  | `grant` (permission matrix) | `create`(G) · `update`(G) · `retire`(G) · `revive`(G) | — |
  | `integration` | `create`(G) · `update`(G) · `retire`(G) · `revive`(G) | — |
  | `config` (singleton org settings) | `update`(G) | — |

  **Revive is a distinct, separately-granted action** per resource — *not* an implicit
  corollary of `retire`. Admin holds all `*:revive` grants by default; delegating narrower
  revive authority is an explicit matrix edit. `user:reactivate` is the deactivation-reversal
  arrow (in-life, reversible), distinct from `user:revive` (post-retirement, pre-GC).
  `session:revoke` covers both `/auth/logout` (`@ own`) and admin "kick a user off all
  devices" (`@ global`). The **"effective admin" predicate** that drives bootstrap re-entry
  (§2.8) and the administrability invariant (§2.8) counts only `permit` grants on
  `{grant:create/update/retire, role:create/update/retire}` at `scope_kind='global'` —
  scoped grants do not count.

  *Notes:* **no `user:create`** — accounts are minted only via `invite` acceptance;
  `task:assign` subsumes claim/unassign (self-vs-other is the `own` scope); *"remove a user
  from my team"* = `user:revoke_role` scoped to that team's inherent role. This list is the
  **capability surface** — concrete policies are authored later, not here.
- **Status is derived, so there is no `status` resource and no `change_status` action.**
  The lifecycle is driven by `task:assign` (claim), `task:submit` (a claimant's submission),
  and `task:review` (the requester approving/returning/rejecting a **submission**); the
  task's status is the **lowest among its claimant slots** (§2.5). Each transition is
  double-gated: Cedar (*who*) + a state-machine guard (*valid from the submission's current
  status*). The `own` scope keys off **different relationships per action** — claimant for
  `submit`, requester for `review`/`complete`/`configure_questionnaire` — handled per policy.

### 2.4 Organization, Divisions & Teams
- **Organization:** singleton; name + zero-or-more integration connections + configuration.
- **Roles** are the atom; users hold one or more directly.
- **Divisions** are the **core axis** and configurable. Each **owns an inherent role**
  (1:1) whose possession is membership and whose grants are division-scoped; supplies a
  **default questionnaire** and **default openings** (and whether requesters may change
  the openings count, §2.6); and serves as a **permission scope**. A division may be a
  pure grouping with no task work (e.g. Leadership).
- **Teams** are **loose**: responsible-party labels that *may* restrict claiming; each
  also **owns an inherent role** (1:1). Subdivisions (e.g. "3D Artist Team") are teams.
- **Claim eligibility:** whether a claimant must belong to the task's division
  and/or team is **configurable** (soft expectation vs. enforced invariant), evaluated
  through the access engine. Eligibility always reads **current materialized Patrice
  state** — it never blocks on or calls an integration. If a role-sync hasn't run yet,
  Patrice acts on what it currently knows; "claiming never depends on Discord" holds even
  in enforced mode.
- **External group mappings** associate Patrice roles to external groups (e.g. Discord
  roles) within a connection, by stable ID. If a mapped external group is deleted, the
  mapping is flagged broken but the role/division/team remains functional.
- **Lifecycle:** divisions/teams/roles are **retired, not deleted** (see 2.10); retiring
  a division retires its inherent role too.

### 2.5 Work Tracking (Tasks)
**Tasks are uniform in shape — what varies is the questionnaire and its submissions
(§2.6), not the task's fields.** Every task has: GUID + editable name, **required
Division**, **optional Team**, requesting User, markdown **description**, **claimant
slots** (openings), a **questionnaire**, claimant **submissions**, a derived **status**,
timestamps, and a **message** thread (§2.7).

- **Claimant slots (openings).** A task has a number of **openings**, seeded from the
  division's `default_openings`; some divisions **lock** the count (requesters can't
  change it). A requester may **close the task to new claims**. A claimant **leaving frees
  their spot — unless they've already submitted**, in which case the spot stays consumed
  and the requester must **add an opening** to invite a replacement. (Single-claimant —
  `openings = 1` — is the common case and behaves exactly as a simple task.)
- **Claiming / leaving** is `task:assign` (self = claim). Eligibility (must the claimant be
  in the task's division/team?) is **configurable** and reads current Patrice state, never
  blocking on sync (§2.4).
- **Submissions carry the work** (§2.6): each claimant produces a **submission** (their
  answers to the questionnaire), versioned across resubmissions.
- **Status — one derived enum, by the min-rule.** Statuses are **not** configurable or
  user-editable. The fixed five-state engine — `Open → Claimed → Review ⇄ Revising →
  Approved` — is carried by **submissions**, and a **task's status is the *lowest* among
  its claimant slots**:
  - an **open spot** (claims open) ⇒ `Open`; a **claimed, unsubmitted** slot ⇒ `Claimed`;
    a **submitted** slot ⇒ that submission's status; **rejected** submissions and
    **closed-unfilled** spots are **excluded** from the min.
  - *Submission cycle:* `task:submit` → **Review**; `task:review` → **Approved** (approve),
    **Revising** (return → claimant resubmits a new version → Review), or **Rejected**
    (set aside, excluded — no resubmit). A submission may also be **retired** (removed +
    GC'd, for junk).
  - *Consequences that fall out for free:* single-claimant reads identically to the simple
    five-state flow; "whole-submission → Review" is automatic (a `Claimed` slot keeps the
    task at `Claimed` until everyone's submitted); a task is **Approved** only when every
    counted slot is `Approved`. For a mixed Review/Revising split the task shows
    **Revising** (the lower).
  - **Manual completion:** the requester (or a leader/admin) may **complete** a task to
    `Approved` regardless of submission states (the bypass).
  - **Two gates per transition:** Cedar (*who may*) + a **state-machine guard** (*is this
    valid from the submission's current status*) — the latter structural, distinct from the
    deferred state-conditional permissions (§6.2).
  - **Self-review** (a requester claiming their own task and reviewing their own
    submission) is a per-org **configuration option** (§2.8).
- **Withdrawal / retirement (orthogonal):** a task can be **retired/withdrawn**
  (`lifecycle_state`, §2.10) from any status — the only *cancelled* exit; there is no
  "rejected/closed" task terminal (rejection is per-*submission*).
- **Querying / views:** Patrice replaces ~20 sheets, so the API serves **paginated**,
  faceted views (by division, team, status, claimant, requester…). v1 filtering is
  **faceted, not permission-scoped** (per-row view visibility is tabled, §2.3).
- **Free-text search** over names/descriptions/answers is **deferred — v1 ships faceted
  filtering only**; revisit post-v1 (candidate: Postgres FTS). Tracked §6.2.

### 2.6 Questionnaires & Submissions
*(Replaces the old per-division "task form" concept — a task's variation lives entirely in
its questionnaire, not in its fields.)*

- **Every task structurally has a questionnaire** — an ordered list of **questions**. The
  uniformity is the point: art's questionnaire is "one attachment," writing's is "one
  detail-text box," testing's is a custom set. There's no special-casing.
- **Question types (7), each with qualities/constraints:**
  1. **Detail Text** — multiline, presented as a richer/larger editor.
  2. **Multiline Text** — plain multiline.
  3. **Text** — single line.
  4. **Numeric** — with a **range** and a **type** (integer / float).
  5. **Dropdown** — single- or multi-select; defined **options**.
  6. **Radio** — single- or multi-select; defined **options**.
  7. **Attachment** — with **allowed filetypes** (image, log, model, audio…).
  Common qualities: **required**, char limits (text), ranges (numeric), options
  (dropdown/radio), filetypes (attachment).
- **Division defaults + per-task customization.** A division supplies a **default
  questionnaire** (config) that **seeds new tasks** (a copy). Most divisions never change
  it; **testing** requesters customize per task via `task:configure_questionnaire`.
  Because each task owns its copy, **editing a division default never mutates existing
  tasks** — the schema-evolution problem dissolves.
- **Submissions = answers to the questionnaire.** A claimant's **submission** is a list of
  **answers**, one per question; an answer's value is a scalar (text/number/choice) *or* a
  **resource** (attachment). So **writing's deliverable is a Detail-Text answer, art's is
  an Attachment answer** — never a description or a message. A submission is **valid** only
  if all *required* questions are answered within their constraints (server-enforced at
  `task:submit`).
- **Versioned, per-claimant.** Each claimant has one submission, **versioned** across
  resubmissions (a return → a new version referencing the prior; surfaces as a new
  top-level message with its own thread, §2.7, so discussion stays scoped to that version).
- **Locked at first submission.** Once *any* submission exists on a task, its questionnaire
  is **frozen** (no edits) — the simplest rule that avoids answer-orphaning; richer
  edit-after-submission handling is deferred (§6.4).

> *Largely settled — the seven types are the spec.* Deferred to §6.4: **reusable/saved
> questionnaires** beyond division defaults (testing teams will want to reuse test forms).

### 2.7 Messages & Attachments
- **The task thread is a stream of messages**, of two kinds:
  - **User messages** (comments) — a sender, markdown content, optional attachments.
  - **System messages** — senderless audit/notification sources ("X submitted", "Y
    reviewed: returned", "task completed"). They both *record* what happened and are what
    **notifications are generated from** (§2.12) — a notification *arrives because of* a
    message; it is not the same object.
- **One-level threading.** Only **top-level** messages can host a thread (a comment, a
  submission, a system event); replies within a thread are **flat** (no reply-to-a-reply).
  This keeps each submission's review conversation isolated — a reviewer can converse with
  tester A without tangling tester B.
- **Submissions surface as top-level messages**, so a resubmission's discussion stays
  scoped to that version (§2.6).
- **User messages may be edited** (with an edited marker) and **retired** (soft); both are
  gated actions (`message:*`, §2.3) and recorded.
- **Time authority:** all ordering and timestamps are **server-authoritative UTC**;
  best-effort ordering rests on this — client clocks are never trusted.
- **Attachments** are referenced by a **message** (a comment's image) or a **submission
  answer** (an Attachment-type question). Hosted in **object/blob storage**. **Upload and
  retire are gated** (`attachment:create` / `attachment:retire`); *download* is a read —
  ungated until view-permissioning lands (§6.2). *Size, allowed types, versioning* → §6.
- **Org-level audit is separate.** Config changes and sync events live in the **`activity`**
  log (§2.10/§5), distinct from task messages — we deliberately don't bind the task thread
  to the internal audit/notification machinery.

### 2.8 Administration & Configuration

**Three configuration layers.**
1. **Startup config** — env vars / file, read **every boot**, never in the DB, never
   UI-editable. Per-install infrastructure + the secrets Patrice itself holds:
   - *Infra:* Postgres connection; object-storage driver + endpoint/bucket/creds (or local
     path); listen port; **public base URL** (builds OAuth redirects + email links);
     trust-proxy / cookie-secure flags.
   - *Crypto:* session/cookie secret; token-hash pepper; Argon2 params.
   - *External auth:* Google OAuth client id / secret / redirect.
   - *Email:* SMTP/provider creds + from-address.
   - *Operational:* log level, environment.
   *(No DB-secret master key — integration auth is **delegated to the provider** (e.g.
   Discord holds it); Patrice custodies no long-lived integration secret. Any future
   provider-token-at-rest is deferred, §6.3.)*
2. **Bootstrap** — seeds the DB once, on first run / recovery: the singleton
   `organization` (name), a **default Admin role** (a *normal* role — editable, deletable —
   pre-seeded with global grants for every action), and the **first admin user** via the
   key-gated special invite below.
3. **Runtime config** — DB, admin UI, version-stamped: org settings (name, session
   lifetimes, **self-review** §2.5, sync precedence); divisions / teams / roles (incl. each
   division's **default questionnaire & openings**); the permission matrix (grants); external
   group mappings; integration connections; invitations. *(Statuses are derived, **not**
   configurable — §2.5.)*

**Bootstrapping — a key-gated special invite.**
- On startup, if there is **no effective admin** (no *active* user holding governance grants
  — `grant:update`, `role:create/update/retire`), the app enters **bootstrap mode**: it
  generates a **bootstrap key**, **prints it to stdout** (server access ⇒ trust), and opens a
  single **special invitation** gated by that key — mechanically just a **passcode-gated
  system invitation** (`created_by = null`, passcode = the key; §2.13).
- The key is **ephemeral** — it lives only for that process run, is never persisted, and dies
  on exit; an unbootstrapped restart mints a fresh one (a leaked old key can't be replayed).
- The special invite resolves through the **ordinary registration flow** (§2.2) — the
  bootstrap user registers like anyone else (email/password or Google) — and is granted the
  default Admin role. Bootstrap mode closes the instant an effective admin exists.
- **This path is also the lockout recovery.** Reaching "no effective admin" (mass user
  deletion, corruption, the last admin deactivated) re-opens bootstrap on next start.
  Re-bootstrap is **idempotent** — it won't duplicate seed data; the new admin **adopts
  existing config**.

**Administrability invariant — hard guard + recovery backstop.**
- The system is **very resistant to losing its last admin**: it **refuses** any operation
  that would leave zero effective admins — removing the last admin's governance grant,
  deleting/retiring/deactivating the last admin, or stripping the Admin role's governance
  grants. An **app-level write-time guard**, *not* a Cedar policy (Cedar decides one action
  at a time; it can't reason about "is an admin path still left"). The Admin role itself is
  **not** special/protected — only this action-level guard is.
- **Re-bootstrap is the backstop** for the states the guard can't catch.

**Config auditability:** configuration changes are recorded in the activity/audit log.

### 2.9 Integrations (provider-agnostic; Discord first)
- **Deferred but anticipated in the model.** External systems are *utilized*, not
  coupled. The data model is **provider-agnostic** — an org may hold **multiple
  integration connections** (even several of one provider), and users/roles may carry
  **multiple external links**. Discord is simply the first provider.
- **Adapter on a message queue:** sync work is enqueued and consumed asynchronously by
  isolated, per-provider adapters, separate from the auth/identity core.
- **What syncs:** Patrice **roles** ↔ external groups, per configured mappings,
  bidirectionally, with per-connection direction and configurable/last-write-wins
  precedence. Membership follows from roles. Removals are tracked in the activity log;
  deletion-propagation policy is an Open Question.
- **No push of task events outward** in v1.
- *Note:* this generalizes the **data model** only; the API-side complexity of running
  several live integrations is acknowledged but out of scope for now.

### 2.10 Entity Lifecycle, Retention & Concurrency
- **Three states: Active → Retired → Deleted.** Core data (roles, divisions, teams,
  users, tasks) is never deleted outright. Retiring marks it inactive while the backend
  **keeps it as long as any references remain**, then **garbage-collects it once
  unreferenced** ("refcount-zero" is the *semantics*; see the mechanics below).
- **GC mechanics — a lazy periodic sweep, not eager counters.** Because retired data is
  already inert (hard-deny below), immediacy isn't needed, so we **don't maintain reference
  counters** (fragile — every FK write would have to update them). Instead a **periodic
  maintenance sweep** (a long-cadence job on the background worker, §4.5) scans retired
  entities and deletes those with **no remaining live references**, checked via **`EXISTS`
  over the known referrer tables** (the FK graph is static → a fixed set of checks per type).
  - **Grace period.** Recently-retired objects are **excluded from GC for a configurable
    window**, guaranteeing a **restore (revive) opportunity** independent of sweep timing.
  - **Aggregate-aware:** a retired task deletes its whole aggregate as a unit (gated on no
    *external* refs); roles/divisions/teams delete individually once their referrer-set empties.
  - **DB is the backstop:** `ON DELETE RESTRICT` FKs (§5.1) mean the collector physically
    can't delete a still-referenced row — a logic bug just fails the delete, retried next sweep.
  - **Object-store cleanup:** deleting an `attachment` row also deletes its blob (after DB
    commit), plus a periodic **orphaned-blob reconciliation** so a crash mid-delete can't
    leak storage.
- **GC aggregate boundary (resolved).** A **task is one composite aggregate** — task +
  messages + submissions (+ answers) + claimant slots + attachments **GC together**.
  **`activity` is never a GC reference** and never GC's with an aggregate: it's the
  immutable, FK-less audit log, retained on its own (partitioning deferred). *This is what
  breaks the "thread entries keep the task referenced forever" deadlock.* Roles/divisions/
  teams GC **individually** once live references hit zero. **Users with authored history
  don't GC** — they scrub to a tombstone stub (below); a user with **no** history GCs fully.
- **Retired data is forcefully unpermissive.** Rather than a separate rectification
  framework, retirement plugs into the access engine: a retired entity is treated as if
  it holds an extremely restrictive, **non-configurable** permission set. Actions that
  touch retired data are therefore denied/blocked by the same pipeline that governs
  everything else.
- **Rectification emerges, it isn't a framework.** Because retired data blocks actions,
  it surfaces as errors that *require* resolution (e.g. reassigning a retired division's
  open requests). The **UI motivates** this; the system can otherwise **live with retired
  data passively**, waiting to collect it. Different retirements warrant different
  treatment — retiring a *user* is not the same as retiring a *division* — but all route
  through retire + pipeline-deny.
- **Retired-entity treatment — one rule, not a per-entity catalog (resolved).** The
  hard-deny targets the retired entity *as actor or direct object* — it does **not**
  transitively poison entities that merely *reference* it (a task in a retiring division
  isn't itself retired). Concretely: **block** all *mutations of/with* the retired entity
  **and new references to it** (no new task in a retired division, no assigning a retired
  user/role); **allow** *existing* references to **complete their lifecycle** (a task in a
  retiring division can still be finished/withdrawn — which is what lets the entity reach
  refcount-zero and GC); **degrade** reads/history (stay visible, marked retired — mostly
  moot, view is tabled). **Revival** is allowed while *Retired* (pre-GC), as the inverse of
  retire (admin-gated); once GC'd it's gone.
- **Retired inherent roles & held memberships (resolved).** Because membership ≡ holding a
  division/team's inherent role, retiring a division leaves users *holding a retired role*
  — a live reference to retired data. The rule: **the retired role's grants go inert
  (denied), but merely holding it is harmless** — an inert membership the GC collects once
  the division is otherwise dereferenced. A user is **never** locked out of themselves,
  because baseline self-access is a global grant, never division-scoped (§2.3). The same
  inertness covers the integration edge: if a user links Discord and a mapped role is
  retired on the Patrice side, sync may record the link but the role **confers nothing** —
  retirement wins over the grant-from-integration path.
- **Users — scrub-in-place on full retirement (resolved).** Deactivation does **not** strip
  roles (it's reversible). On **full retirement** — after the grace period — a user who bears
  **authored history** is **scrubbed in place to a tombstone stub**: the `app_user` row keeps
  only its **GUID** (so every reference stays valid), its **last `display_name`** as the
  label, and `lifecycle_state = retired`; **all PII / active satellites are purged**
  (`user_identity`, `external_identity`, `session`, `auth_token`, `notification`; `user_role`
  stripped; `email` nulled). A user with **no** authored history simply **GCs** (full delete).
  - **No separate table** — moving the row would break the user FK graph (`message.sender`,
    `submission.claimant`, `task.requester`, `activity.actor`, …); scrub-in-place keeps
    integrity. *(A thin side-table is allowed only for extra retained metadata; the stub
    stays in `app_user`.)*
  - The stub is **permanent** (PII gone) — **re-joining is a fresh account** (new GUID; the
    stub remains the historical author).
  - This scrub **is** Patrice's **data-erasure (GDPR-style) mechanism** — purge PII, keep
    authored content under the label. Keeping the last name is the default; **anonymizing**
    it is a per-org option.
  - *Future (not v1):* a way to **combine/merge** users — acknowledged, low priority (§6.2).
- **Concurrency (v1):** **optimistic locking** with basic collision detection (version
  per entity). **Post-v1:** auto-merge of non-conflicting concurrent edits (edits to
  disjoint fields combine automatically).

### 2.11 Sessions
- **Stateful, server-side, identity-only.** A session is a server-side record carrying
  the user's **identity** (GUID) + minimal metadata — **never** cached permissions. Every
  request re-resolves permissions through the access engine (cheaply — see §2.3), so role
  changes, retirements, and deactivations take effect **immediately**.
- **Transport: HTTPS-only.** Web sessions are held in an **httpOnly + Secure + SameSite
  cookie** (with CSRF protection). **No federation/identity server** — Google OAuth2 is
  used directly as the only external **auth** provider (integrations are separate). A
  bearer-token path for programmatic
  callers is a possible **future seam**, not a v1 priority.
- **Concurrency & revocation:** a user may hold **multiple concurrent sessions**
  (multi-device). Privileged users may **view and revoke** others' sessions; user
  deactivation/retirement **cascades to terminate** their sessions. (The revocation UI is
  a lower priority than the deactivation cascade.)
- **Lifetime:** both an **absolute lifetime** and **sliding expiration**, governed by
  **runtime config** (sane defaults shipped).
- **Authentication coupling:** a session is **not inherently tied to its auth method**,
  and Patrice **never forces re-authentication** for actions — except to **invalidate a
  session whose validity is in doubt** on a security signal.

### 2.12 Notifications & Awareness
- **A notification pipe exists in v1** — the API has an in-app **messaging channel to the
  frontend** for awareness of events (a claim, a submission, a review result, a
  comment/reply, an invite, a retired-data block needing resolution). It "basically has to
  exist anyway."
- **In-app only, not email.** v1 notifications are delivered in-app; outbound email is
  reserved for the auth flows (verification/reset, §2.2), not general notifications.
- **One-way and lightweight — not chat.** This is event delivery, not messaging; it does
  **not** make Patrice a real-time chat app (§1.3 non-goal stands). Task messages remain async.
- **Two awareness layers:** (1) the **durable, pull-based record** — a task's **message
  thread** plus the persisted **`notification`** rows (read-state); (2) the **notification
  pipe** is the **push** surface for unread/at-a-glance awareness over that record.
  Retired-data resolution is also reinforced **synchronously** — the offending action
  fails visibly inline at the moment it's attempted, independent of any notification.
- **Transport — decided: SSE.** One-way server→client fits the pipe; plain HTTP (no
  upgrade, sails through the reverse proxy, inherits cookie auth) with native auto-reconnect.
  WebSocket is **not** needed — Patrice has no two-way real-time requirement outside normal
  API requests (presence / co-editing / chat are non-goals). The stream is kept **thin** — a
  "something changed, go sync" signal; the client pulls actual notifications from the table
  (the reconcile-on-connect model below), so durability never rides the stream. (Future WS
  only if a real-time-collaboration goal ever appears.) Dispatch home is §4.5.
- **Delivery guarantee:** the `notification` table is the **durable source of truth**
  (durable-until-read via `read_at`); the push transport is **best-effort**. On
  connect/reconnect the client **reconciles against the table**, so a dropped push never
  loses a notification — it just arrives on next sync rather than instantly.

### 2.13 Invitations
The **sole account-creation path** (bootstrap is itself a special invite). A fundamental,
security-sensitive surface, designed for **mitigation + detection — not perfect prevention.**

- **Bearer-token model & its honest limits.** An invite is a link, `<site>/invite/<token>`,
  and the token is a **bearer credential**: whoever holds it can redeem it. A leaked invite
  **cannot be prevented** from being redeemed by the wrong person — the design **mitigates**
  (short lifetime, limited uses, FCFS) and **detects** (full audit). True prevention — binding
  to a *verified* email/identity, or admin-approval of redemption — is deferred and rides the
  **email-as-verification** thread (§6.2).
- **Token.** A **CSPRNG, URL-safe, unordered ~128-bit** id (nanoid / ID25-style — deliberately
  **not** GUIDv7; unpredictability over ordering, free here since invites aren't index-hot).
  Stored **hashed**, constant-time compared, never logged.
- **Gated creation/revocation** — `invite:create` / `invite:retire` (§2.3).
- **Uses — DB-general, API-single-use.** The DB models uses generally (`max_uses` /
  `use_count`); the **API supports only single-use (`max_uses=1`) in v1**, because the
  validation/identity story only makes sense for one redeemer. The general shape is kept
  (cheap) so multi-use ("anyone with link") can be enabled later without a migration. A
  **"use" is consumed when an account is created** — a tossed invite is **first-come,
  first-served**.
- **Lifetime.** Every invite **expires** (default **7 days**, configurable); expiry is
  re-checked at the atomic redemption step.
- **Pre-assigned roles, privilege-bounded.** An invite may carry `intended_role_ids`, which
  must be a **subset of what the creator may grant** (`user:grant_role` scope, §2.3) —
  validated at creation **and re-validated at redemption** (a since-shrunk creator scope can't
  leak privilege). A Writing lead cannot mint an Org Admin via an invite.
- **Passcode gate = the bootstrap mechanism.** The model supports an optional out-of-band
  **passcode** (`passcode_hash`). A normal admin invite won't use it (you'd have to send the
  link *and* the passcode separately), so it's **not a general API feature** — but it cleanly
  expresses **bootstrap**: a system-created invite (`created_by = null`) gated by the ephemeral
  bootstrap key as its passcode (§2.8).
- **Redemption is a deliberate POST, not a GET.** `GET /invite/<token>` is **read-only** (shows
  the registration page); account creation + use-consumption happen on **POST**. This defends
  against link unfurlers (Discord/Slack) and email scanners that auto-fetch URLs and would
  otherwise burn or expose the invite before the human acts.
- **FCFS is atomic.** Use-consumption is a single guarded write (`use_count < max_uses` +
  `status=pending` + not expired, increment, one statement), so concurrent redeems can't
  over-issue, and revocation/expiry are honored at the instant of creation.
- **Auditability.** Each redemption writes an **`invitation_use`** record (which invite → which
  created user, when), the new `app_user` records `created_via_invitation_id` provenance, and
  create/redeem/revoke are logged to the activity feed. Audit **survives the invite's
  retirement**. (Redemption endpoints are rate-limited — §6.3.)
- **Pending invites on issuer state changes (resolved).** The policy splits by reversibility:
  on **deactivation** (reversible) nothing proactive happens — Slice 1's redemption-time
  re-validation (`intended_role_ids ⊆ creator's current grantable roles`) lazily handles the
  gap, and the issuer's invites recover automatically if reactivated. On **retirement** (the
  irreversible scrub) the system **proactively flips `revoked_at = now()`** on every still-
  pending invitation `WHERE created_by = $userId`, in the scrub transaction; one
  `activity` row per invite is written with `verb='invite.auto_revoked_on_issuer_retired'`,
  `actor_user_id=NULL` (system). **Bootstrap invites** (`created_by IS NULL`) are immune —
  only the explicit no-effective-admin trigger closes them.

### Open Questions — Design Goals
*All open Design-Goals items are rolled up in **§6**: session security signals (§6.3),
pending-invite fate (§6.4), and the various deferred features/concern-areas there.*

---

## 3. Web (Frontend)

*Scope: The frontend service tier. **Framework decided: Angular**, signals-first. The
governing requirement is a **strong, structural division between UI and behavior** —
enforced by the framework, not by discipline.*

### 3.0 Architecture stance — layered & segmented
The frontend mirrors the API's ports-&-adapters (§4.0): a **hard separation** between
presentational UI and the behavior that drives it, enforced by Angular's **dependency
injection**. Three layers with one-way dependencies:

1. **Presentation** — components are *dumb*: render signals, emit events. **No** business
   logic, **no** HTTP, **no** orchestration. `ChangeDetectionStrategy.OnPush`.
2. **Application / behavior** — injectable **signal stores** and use-case services: the
   brain. Owns state, derivation, orchestration. Framework-render-free, so unit-testable
   without mounting a component.
3. **Data access** — a **typed client generated from the API's OpenAPI spec** (§4.1, REST
   decided) + server-state handling; the only layer that talks HTTP.

Module/import boundaries follow a **Feature-Sliced-Design-style** discipline
(`shared → entities → features → pages → app`) so a feature can't reach sideways into
another's internals. *The litmus test: if behavior can be tested with zero components
mounted, the separation is real.*

### 3.1 Framework & rendering
- **Angular**, **standalone components** (no NgModules), **signals-first**, `OnPush`
  everywhere, new control flow (`@if`/`@for`/`@switch`).
- **SPA** by default — Patrice is an authenticated internal admin tool, so SSR/SEO buys
  little; SSR stays an option but is **not** v1. Build via the Angular CLI (esbuild).

### 3.2 State & reactivity (signals-first)
- **Signals for state and derivation** (`signal` / `computed` / `effect`) — the ~95%.
  This is what sidesteps the "RxJS everywhere," flow-centered feel of classic Angular.
- **RxJS only at async I/O edges** (HTTP, SSE/WebSocket), bridged into signal-land **once**
  at the boundary via `toSignal`. The notification stream (§2.12) is the canonical case.
- Behavior is injectable signal **stores**; components consume `store.someSignal()` and
  call `store.someAction()` — they never hold business state themselves.

### 3.3 Data access & the contract
- A **typed API client generated from the OpenAPI spec** (§4.1, REST + OpenAPI decided) —
  the contract is the boundary, regenerated on API change; no hand-written request code in
  components.
- **Server-state** (fetch/cache/invalidate) lives in the data layer, not components —
  via an Angular query library or `httpResource`/`resource()`-style reactive fetching.
- **The client never enforces permissions.** It *reflects* them: the API is the sole
  authority (§2.3). Client-side guards/visibility are **UX only**; every action is
  re-authorized server-side, and `401/403` are handled as first-class responses.

### 3.4 Dynamic questionnaire rendering
Tasks carry a **questionnaire** (§2.6) — an ordered list of typed questions — that the
client must render both for **authoring** (testing requesters) and **answering**
(submissions). A **questionnaire → Reactive Form** mapping lives in the **application
layer** (questions in → `FormGroup` out), while a presentational renderer walks the seven
question types to draw controls. This keeps the form *engine* (behavior) separate from
*rendering* (UI), and the same machinery serves the config/permission-matrix editors.

### 3.5 Client-side auth & session handling
- Sessions are an **httpOnly cookie** (§2.11) — the SPA holds **no token** and cannot read
  it (XSS-resistant). Requests are cookie-authenticated; CSRF protection per §4.3.
- **Route guards reflect** the user's resolved capabilities for navigation/UX, but are not
  trusted — the server re-checks every call.
- Login, Google-OAuth redirect, invitation acceptance, and password reset/verification
  (§2.2) are dedicated unauthenticated routes.

### 3.6 Notifications client
Consume the §2.12 pipe (**SSE**, §4.5) as a **signal-backed store** — an `EventSource`
bridged via `toSignal`; treat its events as a thin "go sync" signal and reconcile the
unread badge + feed against the `notification` API/table. One-way and lightweight — not chat.

### Open Questions — Web
*All open Web items are rolled up in **§6**: server-state tooling & questionnaire rendering
(§6.5), the design system & FE UX states (§6.3); notification transport is decided (SSE,
follows the server transport choice).*

---

## 4. API (Middleware)

*Scope: The API service tier — the contract between Web and Database, plus its
internal architecture. Language-neutral contract; TS-specific choices isolated.*

> **Mostly a research survey, with several decisions now committed:** the contract is
> **REST + OpenAPI** (§4.1), the runtime is **TypeScript** (§4.2), and the policy engine
> **centers Cedar** (§4.4). Everything else is candidates + **tentative leanings**, tied to
> our established principles: a **language-neutral contract** (for the strict tier boundary
> + an explicit external artifact) and **Postgres as the spine** (minimal extra infra for
> self-hosting). *(Bulk-visibility-
> via-SQL-predicates is **tabled** — see §4.4; it is no longer a guiding principle.)*

### 4.0 Internal architecture stance — ports & adapters
To keep the **strict tier boundaries** and a **testable, framework-independent domain
core** (roles, tasks, the access policy, lifecycle/retirement), the core is isolated from
framework and I/O via **ports & adapters (hexagonal)**: the core depends on interfaces;
HTTP, persistence, OAuth, queue, and the integration adapters are pluggable implementations.
*The payoff is testability and clean boundaries; that a Rust port would also be eased is now
a bonus, not the goal.*

### 4.1 Protocol & contract — **decided: REST + OpenAPI**
The filter-heavy task views and dynamic config-driven forms shaped this choice. The
options were weighed as below; **REST + OpenAPI is committed.**

| Option | Fit | Cost |
|---|---|---|
| **REST + OpenAPI** | Language-neutral schema, cacheable, ubiquitous tooling/codegen, plays naturally with cookie sessions. | Verbose for nested/filtered reads; over/under-fetching; filter grammar is hand-designed. |
| **GraphQL** | The client fetches exactly the filtered view it needs; one endpoint; strong typing; introspection drives the dynamic UI well. | Field-level authz is fiddly (our access engine must hook resolvers); caching harder; needs depth/cost limiting + dataloader (N+1). |
| **RPC — tRPC** | Best-in-class end-to-end TS type safety, minimal boilerplate. | **TS-on-both-ends coupling** — it's a binding, not a contract; erodes the strict tier boundary and leaves no external artifact. |
| **RPC — Connect/gRPC** | Protobuf = language-neutral; great service-to-service; Connect works in browsers. | Heavier toolchain; less idiomatic for a CRUD-ish web app. |

**Decision — REST + OpenAPI**, with a deliberately-designed filter/query grammar and
cursor/offset pagination. Rationale:
- **Authz fit (decisive):** one endpoint = one action on one resource = **one Cedar
  `is_authorized` check**. GraphQL's field-level authz would multiply the surface on our
  riskiest component (the access engine).
- **Fit for our UI:** a known-shape admin/CRUD tool with designed views; GraphQL's
  flexible-fetching edge is muted — and its best case (per-row visibility filtering) is
  **tabled** (§4.4).
- **Operational simplicity:** HTTP caching, no dataloaders / query-cost limiting — suits
  self-hosting at our scale (~200 users / ~100k tasks).
- **Explicit, external contract:** OpenAPI is a versionable, third-party-consumable
  artifact and gives Angular a generated typed SDK.

**Not TS-coupled — on purpose.** Both tiers are TypeScript, but the contract's **source of
truth is the language-neutral OpenAPI spec, never TS types.** tRPC / shared-type contracts
are rejected because they (a) erode the strict Web↔API boundary — the FE would import BE
types, coupling the tiers in lockstep; (b) leave no external, versionable,
third-party-consumable artifact. *(They would also foreclose a Rust port — but that is no
longer a design driver, §4.2; the tier-boundary and artifact reasons stand on their own.)*
**Code-first is fine:** define handlers with Zod/TypeBox and *emit* OpenAPI from them — TS
ergonomics on both ends, a language-neutral artifact in the middle. The rule: *TS may
implement a tier; it may not **be** the contract.*

**Considered & rejected:** GraphQL (authz surface + operational complexity vs. muted
benefit), tRPC / shared-types (TS-coupling erodes the tier boundary and leaves no external
artifact), Connect/gRPC (heavier toolchain, less idiomatic for a CRUD web app).

**Query conventions — decided:**
- **Pagination: keyset / cursor**, not offset — efficient at any depth and stable under
  concurrent inserts. The **uuidv7 PK doubles as the cursor** for default (newest-first)
  order; other sorts use a `(sort_key, id)` cursor. (No random page-jumps — fine for
  filter-and-scroll lists replacing sheets, §2.5.)
- **Filters: typed, faceted query params**, each mapping to an **indexed column** (division,
  team, status, claimant, requester, date ranges), AND across facets, with `in:` (multi-
  value) and range operators. No arbitrary boolean DSL — keeps every query index-backed and
  matches the "faceted, not permission-scoped" list model (§2.5). Free-text `?q=` (if §6.2
  search lands) is a separate, orthogonal param.

### 4.2 Language, runtime & framework
**TypeScript — decided** (velocity + ecosystem at our scale). A **Rust reimplementation is
no longer pursued** — Cedar (JS bindings) and Prisma (TS schema) have deepened TS-coupling
enough that a swap is a growing cost for a narrowing benefit (see Guiding Context). Within TS:
- *Runtime:* **Node.js** (mature, safe default) · **Bun** (fast, some ecosystem gaps) ·
  **Deno** (secure-by-default).
- *Framework:* **NestJS** (opinionated, DI, modular — suits a complex multi-module domain
  like ours; more boilerplate) · **Fastify** (light, fast, schema-first validation) ·
  **Hono** (modern, runtime-agnostic, great TS ergonomics) · Express (dated).
- *Leaning:* **NestJS or Fastify** — Nest if we value the enforced module structure for
  the access engine / adapters / domain split; Fastify if we'd rather assemble a leaner
  stack ourselves. Hono is the dark-horse if runtime-agnosticism appeals.

**Rust path — deprioritized.** Previously the "swap option" (Axum/Actix); we no longer
treat it as a target. Ports & adapters (§4.0) and the language-neutral contract (§4.1) are
kept for their own merits, not to hold this door open. If raw performance or a single
binary ever became a hard requirement, the door isn't *bricked* — it's just no longer a
factor in day-to-day decisions.

### 4.3 Auth, sessions & invitation acceptance
*HTTPS-only. Google OAuth2 handled directly (no federation server). Sessions are
**stateful, server-side, identity-only** records (user GUID + metadata), carried in an
httpOnly/Secure/SameSite cookie with CSRF protection; storage is DB-backed and
cache-accelerated (§4.8). Supports multiple concurrent sessions, admin + deactivation-
cascade revocation, and absolute + sliding lifetimes from runtime config. Per-request,
the session resolves to identity only — permissions come from the access engine (§4.4).
A programmatic bearer-token path is a deferred seam. Strictly separated from the
integration adapters.*

**Options under investigation:**
- *Session store:* **Postgres-backed** (single source of truth, transactional with user
  state, survives restarts) vs **Redis** (TTL-native, fast). *Leaning:* Postgres primary,
  optionally fronted by the §4.8 cache — avoids requiring Redis for a single-org install.
- *OAuth (Google):* a focused library (**Arctic** for provider flows; **Passport** in the
  Node world) over a heavy framework. Note **Lucia is deprecated** (now a reference, not a
  dependency) — opaque-token-in-cookie + a `sessions` table is simple enough to own
  outright.
- *Version-stamp mechanism* (for §4.4 cache invalidation): a monotonic counter on the
  scope — **decided: org-wide** (`organization.config_version`), bumped on any role/config/
  retirement change; read cheaply, used
  as the resolution cache key.
- *TLS:* HTTPS terminated at a reverse proxy (**Caddy** auto-TLS / nginx) — friendly to
  self-hosting; the app assumes it sits behind TLS.

### 4.4 Access engine (permissions)
*The single, centralized, MediaWiki-style pipeline through which **every gated action**
(the `resource:verb` vocabulary, §2.3 — no `view`) is evaluated. Resolves the actor's
(multiple) roles → grants, applies global and scoped grants against the target's
division/team/ownership. Retired entities feed in as a non-configurable hard-deny. The DB
never encodes permissions.*

*Performance model: (1) the engine's **inputs** — the projected Cedar policy set + the
actor's role entities — are **cached** (per org / per user), invalidated by a **version
stamp** that increments on any role/config/retirement change, so they rebuild only on
actual change (immediate, not per-request); (2) **Cedar `is_authorized`** does
resolution+decision per request over those cached inputs — sub-millisecond on bounded
inputs; (3) **bulk visibility** — **tabled** (see the Direction below; a minor need for our
uses). *Were it built*, it would compile into **query predicates** (row filtering at the
DB). Only layers 1–2 are in scope for v1; the §4.8 cache backs layer 1 (the inputs).*

**Direction: center Cedar for point-decision policy.** Cedar (AWS, Rust core + Wasm/JS
bindings) is the chosen basis for general authorization. It fits our model unusually well:
**deny-by-default**, **`forbid` overrides `permit`** (a clean expression of "retired =
non-configurable hard-deny"), multiple roles as group membership, and **runtime-adjustable
policies** — Cedar policies/templates and entity data load at runtime and can be
**schema-validated before activation**, which is ideal for an admin UI that edits the
permission matrix live.

- **Representation — decided: (ii) grants as Cedar policies (template-links).** Let Cedar
  own **both** role→grant matching *and* scope evaluation — it is purpose-built and fast at
  exactly this, so we don't pre-resolve it ourselves. The configurable matrix lives **as
  policies**:
  - **Template vs. link — the load-bearing distinction.** A **template** is the fixed,
    code-reviewed authorization *logic*; it **names no specific role** (it has `?principal`/
    `?resource` slots) and never changes at runtime. A **template-link** is pure runtime
    *data* — a binding (`?principal = Role::"…"`, `?resource = Division::"…"`) **equivalent
    to a `grant` row**, carrying no logic. So the *rules* are fixed and reviewable (the
    template library + the static policies below); only the *data bindings* are dynamic.
    (N.B. Cedar policies are always **runtime-loaded data**, not compiled into the binary;
    the sole compile-time artifact is the **schema** — the entity/action/attribute *types*.
    Specific roles are runtime entities.)
  - A small **template library**, one per *scope-shape*: `global`; `division`/`team`
    (resources are modeled **`in`** their Division/Team groups, so scope = `resource in
    ?group` — Cedar's hierarchy does the work); `own` (condition `resource.requester ==
    principal`, per resource type); `role` (for `grant_role`: target role `in` a role-scope
    group — the `scope_role_id` seam).
  - **Each `grant` row → one template-link**, a deterministic projection from the grant
    table (which stays the admin-facing source of truth; rebuilt on startup, patched on
    edit). Each link is **schema-validated before activation** — a bad matrix edit is
    rejected at write time.
  - Static (non-generated) policies for the **retired `forbid`** (`when { resource.retired }`,
    overriding permits) and **baseline self-access**.
- **Perf is reframed around Cedar's speed, not pre-resolution.** Cedar `is_authorized` is
  sub-millisecond on bounded inputs (a user's roles, one resource, a few hundred policies),
  so we cache the engine's **inputs** — the projected policy set + the actor's role entities,
  version-stamped — and let Cedar resolve+decide per request. (This replaces the earlier
  "layer-1 = our capability resolver" idea, which redundantly did Cedar's matching.)
- *Cost (accepted):* a **policy-store projection** kept in sync with the grant table —
  modest (rare edits; hundreds of policies). In exchange: **all authz logic lives in Cedar**
  (single source of truth, no TS-side matcher), and every edit is schema-validated.
- *Unchanged:* the **administrability invariant (§2.8) is NOT a Cedar policy** — Cedar
  decides one action at a time and can't reason about "is an admin path still left"; it
  stays an **application-level write-time guard** on `grant`/`role` mutations — as is the
  **status state-machine transition guard** (§2.5): Cedar gates *who* may `task:submit`/
  `review`; the guard gates *whether* the transition is valid from the current status.
- *Caveat — Cedar is a decision engine, not a filter engine.* It answers "can P do A on
  R?" one resource at a time; it does **not** emit a SQL predicate for "all rows P may
  view." So **layer-3 bulk visibility is tabled** (see below) — for our uses visibility is
  a much smaller need and may not be relevant. If revived, the predicate path stays
  hand-rolled and must be kept consistent with Cedar from a single config source.
- *Caveat — JS/TS bindings* are thinner than the Rust core; validate the binding's
  maturity during prototyping.

### 4.5 Background work & message queue
*Async tasks and the queue that feeds the isolated integration adapters. Also the
dispatch home for the **v1 notification pipe** (§2.12, transport = **SSE** — one-way, thin
"go sync" signal) and the outbound-email flows (verification/reset, §2.2). The **GC sweep**
(§2.10) also runs here as a periodic maintenance job.*

**Options:** **pg-boss** / **Graphile Worker** (Postgres-backed — no extra infra, fits
"Postgres as the spine") vs **BullMQ** (Redis-backed, the mature standard). *Leaning:* a
**Postgres-backed queue** for v1 so a self-hosted install is just "app + Postgres";
revisit if throughput ever demands Redis.

### 4.6 Concurrency control
*Optimistic locking (entity versioning) for v1; the seam where post-v1 auto-merge
rectification of non-conflicting edits would live.*

### 4.7 Organization seam
*Where the single-org assumption is enforced and how it could widen.*

### 4.8 Caching (read-shield)
*A lower-level concern inside the API — possibly handled transparently by the ORM. Its
job is to spare Postgres from repeated reads; it is **deferrable** and added when load
warrants, but kept in mind during development. Not a database-tier component.*

**What we'd cache:** the read-heavy / rarely-changing data — the **access-engine inputs**
(the projected Cedar policy set + per-user role entities, §4.4 layer 1), **org config**
(roles, divisions, teams, default questionnaires), and hot rows. High read:write ratio = cache-friendly.

**Two axes:**
- *In-process (LRU in the API process)* — instant, **zero extra infra**, but per-process
  (multi-instance needs fan-out invalidation) and lost on restart (harmless). Ideal for a
  single-org / single-instance install.
- *External (Redis/Valkey)* — shared across instances, survives restarts, native TTLs,
  could double as session/queue store; cost is **another service to run**, cutting against
  "app + Postgres" self-hosting.
- *ORM-managed vs. explicit* — some ORMs cache results, but their invalidation is blunt
  (usually time-based). Fine for ordinary data; **for permissions/config, stale = wrong
  access**, so cache those **explicitly** and key them on the **version stamp** (no stale
  window — a write makes old entries instantly unreachable).

**Stance:** **don't build it up front** (Postgres + indexes + its own page cache is enough
for one org); **do build the seam** (route config/permission reads through a small
interface); when warranted, start **in-process, version-stamp-keyed**, graduate to Redis
only for multi-instance or a shared substrate.

### 4.9 Validation (questionnaire & submissions)
Runtime validation is needed at the API boundary and to validate a **submission's answers**
against the task's **questionnaire** (§2.6) — required questions answered, within each
question's constraints (char limit, numeric range/type, allowed options, allowed filetypes).
- *TS validators:* **Zod** (de-facto DX) · **TypeBox** · Valibot · ArkType — for request
  validation and to *emit* the OpenAPI contract (§4.1).
- *Questionnaire validation:* the question set is a small, **closed type vocabulary** (7
  types, §2.6), so submission-answer validation is a direct per-type check — no general
  schema engine needed. The questionnaire definition is a **portable data artifact** the
  Angular renderer (§3.4) and server share.

### 4.10 ORM / persistence layer — **decided: Prisma**
**Prisma** is the ORM. Chosen for its **DX, mature migrations (Prisma Migrate), and
tooling**; the old deploy-weight knock has largely evaporated (recent versions drop the
Rust query-engine binary), and tabling bulk visibility removed the dynamic-SQL pressure
that used to favor a bare query-builder. *(Considered: Drizzle — leaner/SQL-first;
MikroORM — richer aggregate/unit-of-work modeling; both viable, Prisma wins on DX +
migrations.)* It lives **behind repository ports** (§4.0) so the domain core stays ORM-agnostic.

**Prisma-specific considerations to handle in the build:**
- **Optimistic locking is manual** — Prisma has no `@Version`; do a version-guarded
  `update where { id, version }` and treat a 0-row result as a conflict. Wrap in a repo helper.
- **Soft-retire default filter** — use **Prisma Client Extensions** to inject
  `where lifecycle_state = 'active'` by default, with an explicit opt-out for admin/history
  views, so retired rows are excluded unless asked for.
- **Advanced Postgres features may need raw migration SQL** — partial indexes (e.g. unique
  on active rows), `citext`, and GIN on JSONB aren't all first-class in the Prisma schema;
  Prisma Migrate lets us hand-edit the generated SQL where needed.
- **JSON typing is weak** (`Json`/`JsonValue`) — fine, because submission **answers** are
  validated against the task's questionnaire at the API (§4.9); type them with Zod at the edge.
- **Two schema artifacts** — `schema.prisma` (DB) and the OpenAPI spec (contract) are
  distinct layers and may differ deliberately; don't let the DB schema leak as the API shape.

### Open Questions — API
*All open API items are rolled up in **§6**: tabled bulk-visibility (§6.2), Cedar JS/TS
binding maturity (§6.1), and sync conflict/deletion mechanics (§6.2). (Version-stamp
granularity and query conventions are now decided — §4.3/§4.1.)*

---

## 5. Database

*Scope: The data tier — Postgres, the ORM/query layer, migrations, and the object store
for attachments. (Caching is an API-tier concern — see §4.8.) Holds only internal
representations of facts; **never encodes permissions** (that's the access engine's job —
the `grant` table here is *configuration data the engine reads*, not enforcement).*

> The schema below is a **first full mapping**, not frozen DDL. Types are Postgres.
> It deliberately realizes every Design-Goals decision: roles as the atom, inherent 1:1
> division/team roles, GUID-identity-vs-face, soft-retire + GC, optimistic locking, the
> version stamp, per-fact sync source/timestamp, per-task questionnaires + versioned
> submissions, and the strict separation of auth identity from integration linkage.

### 5.1 Conventions
- **Primary keys — `uuid` (v7).** Every entity's true identity is a UUID (time-ordered v7
  for index locality). Human-facing `name`/labels are *separate, mutable* columns
  ("identity ≠ face").
- **Organization seam.** Every tenant-scoped table carries `organization_id`. In v1 it is
  always the singleton org; this is the one place the single-org assumption lives, and
  widening to multi-org becomes "filter by org / add RLS" rather than a reshape.
- **Timestamps.** `created_at` / `updated_at` (`timestamptz`, UTC) on all mutable rows.
- **Lifecycle / retirement.** Core rows carry `lifecycle_state` (`active | retired`;
  users add `deactivated`) + `retired_at`. FKs to core data use **`ON DELETE RESTRICT`** —
  nothing is hard-dropped while referenced. A **GC job** deletes retired rows only once
  their reference count reaches zero (Active → Retired → Deleted). Retirement's *meaning*
  (forced-deny) lives in the access engine, not here.
- **Optimistic locking.** Mutable aggregate roots (`task`, `app_user`, `role`, `division`,
  `team`, `message`, `submission`) carry an integer `version`, bumped per write; a stale
  version = a conflict.
- **Version stamp.** `organization.config_version` (monotonic `bigint`) bumps on any
  config change; the API's permission-resolution cache keys on it (**org-wide** granularity,
  §4.3 — decided).
- **Sync facts.** Rows that may sync bidirectionally with an integration carry `source`
  (`patrice | integration`) + `source_connection_id` + their own `updated_at` for
  last-write-wins precedence.
- **JSONB** for flexible-but-structured payloads: form schemas (JSON Schema), task
  question `constraints`, answer `value`, activity `payload`, org `settings`. GIN-indexed where queried.
- **Enums** via Postgres `enum` or check-constrained text; `citext` for emails.

### 5.2 Schema — Identity, Organization & Integrations
*Two deliberate separations live in this schema. (1) **Auth ≠ integration:**
`user_identity` (authentication: password/Google) is distinct from the integration
linkage tables. (2) **Integrations are provider-agnostic:** nothing here names Discord in
a column — an org may hold **multiple `integration_connection`s** (even several of the
same provider), and users/roles may carry **multiple external links**. Discord is simply
the first `provider`. (The API-side complexity of multi-integration sync is out of scope
here — it has no further effect on the data model.)*

**`organization`** — singleton owner of all data/config.
`id` · `name` · `settings jsonb` (session lifetimes, sync precedence, self-review flag, …) ·
`config_version bigint` · timestamps.
*(Single row enforced by app/CHECK. The Discord-guild binding moved to
`integration_connection`.)*

**`app_user`** — Patrice-native identity (name avoids the `user` keyword).
`id` · `organization_id` · `email citext null` (canonical contact; unique per org) ·
`display_name text` (editable face; the tombstone label) · `created_via_invitation_id uuid
null` (provenance) · `lifecycle_state (active|deactivated|retired)` · `deactivated_at` ·
`retired_at` · `version` · timestamps.
*On full retirement (post-grace) the row is **scrubbed to a tombstone in place** (§2.10):
keep `id` + `display_name`, set `retired`, null `email`/PII, and purge its satellites
(`user_identity`/`external_identity`/`session`/`auth_token`/`notification`, strip
`user_role`). It is never moved — FKs to `app_user.id` must stay valid.*

**`user_identity`** — **authentication** method; one user → many. *(Not an integration.)*
`id` · `user_id` · `provider (password|google)` · `provider_subject text null` (Google
`sub`) · `password_hash text null` (Argon2; password only) ·
`verified_at timestamptz null` (email-ownership proof; password identities start null,
Google identities start `verified_at = created_at` since Google verifies upstream;
bootstrap-invite acceptance unconditionally stamps `verified_at = now()`) · timestamps.
Unique `(provider, provider_subject)` and `(user_id, provider)`.

**`integration_connection`** — an org's link to one external workspace; replaces
`organization.guild_id`. An org may have many.
`id` · `organization_id` · `provider (discord|…)` · `external_workspace_id text`
(e.g. Discord guild snowflake) · `display_name` · `config jsonb` (provider-specific:
sync direction/precedence, bot scopes, …) · `credentials_ref text null` (seam — points at
where any per-connection credential would live; v1 **delegates integration auth to the
provider**, so typically empty — provider app creds sit in startup config (§2.8), at-rest
handling deferred §6.3) · `status (active|broken|disabled)` ·
`lifecycle_state` · `retired_at` · timestamps. Unique `(organization_id, provider,
external_workspace_id)`.

**`external_identity`** — a user's account in one connection; replaces
`discord_account_link`, generalized. *(Integration, deliberately separate from
`user_identity`.)*
`id` · `user_id` · `connection_id` (FK → `integration_connection`) ·
`external_user_id text` (snowflake/external id) · `external_handle text null` (cached) ·
`linked_at` · `last_synced_at`. Unique `(connection_id, external_user_id)` and
`(user_id, connection_id)`. A user may link across **multiple** connections.

### 5.3 Schema — Authorization & Structure
**`role`** — the authorization atom.
`id` · `organization_id` · `name` (face) · `kind (standalone|division|team)` ·
`division_id uuid null unique` (set iff `kind=division`) · `team_id uuid null unique`
(set iff `kind=team`) · `lifecycle_state` · `retired_at` · `version` · timestamps.
*CHECK: kind ⇔ the matching FK is non-null. The inherent-role 1:1 is the unique FK; no
circular reference (division/team do not point back).*

**`division`** — core axis.
`id` · `organization_id` · `name` (face) · `default_openings int default 1` ·
`openings_locked bool` (requesters can't change a task's openings) ·
`restrict_claims bool default false` (claim eligibility — AND-composed with
`team.restrict_claims`; Cedar reads both at `task:assign @ own_as_claimant`) ·
`lifecycle_state` · `retired_at` · `version` · timestamps.
*Its default questionnaire (if any) is the `questionnaire` row with
`owner_division_id = this.id` (§5.4). Absence of such a row marks a coordination-only
division (e.g. Leadership) — task creation in such a division returns
`422 NO_DEFAULT_QUESTIONNAIRE`; a zero-question questionnaire is the explicit way to
support coordination-only tasks.* Its membership/permission carrier is the `role` row
with `division_id = this`.

**`team`** — loose grouping (subdivisions are teams).
`id` · `organization_id` · `name` · `restrict_claims bool` (non-members barred from
claiming its tasks) · `lifecycle_state` · `retired_at` · `version` · timestamps.

**`user_role`** — role assignment = membership; the **syncable fact**.
`id` · `user_id` · `role_id` · `source (patrice|integration)` ·
`source_connection_id uuid null` (FK → `integration_connection`; which integration set
it, if any) · `granted_by uuid null` (null = via sync) · `granted_at` · `updated_at`
(LWW). Unique `(user_id, role_id)`.
*Holding a division/team's inherent role **is** membership — no separate membership table.*

**`external_group_mapping`** — Patrice role ↔ an external group, by stable ID; replaces
`role_discord_mapping`, generalized across providers.
`id` · `role_id` · `connection_id` (FK → `integration_connection`) ·
`external_group_id text` (e.g. Discord role snowflake — survives renames) ·
`sync_direction (inbound|outbound|bidirectional)` · `is_broken bool` (external group
deleted) · timestamps. Unique `(role_id, connection_id, external_group_id)`.
A role may map into **multiple** connections.

**`grant`** — the configurable permission matrix; **source data the access engine
translates into Cedar** (representation (i)). Not enforcement.
`id` · `organization_id` · `role_id` · `action text` (closed **`resource:verb`** vocabulary
— see §2.3; e.g. `task:create`, `task:assign`, `task:submit`, `task:review`,
`task:complete`, `task:configure_questionnaire`, `task:manage_claims`, `message:update`,
`user:grant_role`, `division:update`, `grant:update`, `config:update`;
**no `read`/`view`**) · `effect (permit|forbid)` ·
`scope_kind (global|own|own_division|own_team|specific_division|specific_team|role)` ·
`scope_division_id null` · `scope_team_id null` · `scope_role_id null` · timestamps.
*Scopes: `own` = actor authored/requested/owns the target (§2.3 O-tag); `role` +
`scope_role_id` bound **which** roles `user:grant_role`/`revoke_role` may touch (the
scoped-role-granting seam). The full vocabulary lives in §2.3. Status is **derived** (§2.5),
so there is no `change_status` grant — the lifecycle is driven by `task:submit`/`task:review`.*

### 5.4 Schema — Work Tracking
*Status is **not** a column to set — it's **derived** (§2.5): per-submission states, and a
task's status = the lowest among its claimant slots. A `task.status_cache` enum may be
stored for cheap filtering, but it's recomputed, never user-written.*

**`task`** — the unit of work (uniform shape).
`id` · `organization_id` · `name` (face) · `description text` (markdown) · `division_id`
(**required**) · `team_id null` (**optional**) · `requester_user_id` ·
`openings int` (seeded from `division.default_openings`) · `claims_closed bool` ·
`status_cache enum null` (derived, `open|claimed|review|revising|approved`) ·
`lifecycle_state` · `retired_at` · `version` · `created_at` · `updated_at`. Indexes:
`division_id`, `team_id`, `status_cache`, `requester_user_id`.
*(The task's questionnaire is reached via the inverse relation `questionnaire WHERE
owner_task_id = task.id` — see `questionnaire` below.)*

**`questionnaire`** — a question set, owned by exactly one division (as its default) **or**
one task (its copy). Ownership lives **on the questionnaire** via owner columns + UNIQUE +
CHECK, not on the parent via back-refs (revised from an earlier draft — back-refs were
redundant once owner columns enforced exclusivity, so dropped; this also avoids a
chicken-and-egg circular FK between `task` and `questionnaire`).
`id` · `organization_id` · `owner_division_id uuid null UNIQUE → division(id)` ·
`owner_task_id uuid null UNIQUE → task(id)` · CHECK exactly one owner is non-null ·
`created_at`. *(A task's copy is seeded from its division's default and locked once the
task has a submission.)*

**`question`** — one prompt.
`id` · `questionnaire_id` · `ordinal int` · `type (detail_text|multiline|text|numeric|
dropdown|radio|attachment)` · `prompt text` · `required bool` · `constraints jsonb`
(char limit / numeric range+int|float / options / allowed filetypes).

**`submission`** — a claimant's answers; **versioned** via the resubmission counter.
`id` · `task_id` · `claimant_user_id` · `submission_no int` (the resubmission counter
v1/v2/v3 — part of the row's identity, never mutated after insert) ·
`prev_submission_id uuid null` (resubmission chain) ·
`state (review|revising|approved|rejected)` · `submitted_at` · `reviewed_by uuid null` ·
`reviewed_at null` · `lifecycle_state` (retire = remove+GC) · `retired_at` ·
`version int` (the global optimistic-lock convention — distinct from `submission_no` and
incremented on every `task:review` write). Unique `(task_id, claimant_user_id, submission_no)`.
*(The column was previously called `version` for the resubmission counter — renamed to
`submission_no` so the optimistic-lock `version` column can do its conventional job
without collision.)*

**`answer`** — one answer to one question (value scalar **or** a resource).
`id` · `submission_id` · `question_id` · `value jsonb null` (scalar/choices) ·
`attachment_id uuid null` (for Attachment-type). *(API/UI treat a submission uniformly as
a list of answers; the DB just juggles the attachment ref where the answer is a resource.)*

**`task_claimant`** — claimant slots (occupancy).
`id` · `task_id` · `user_id` · `joined_at` · `has_submitted bool` (so leaving keeps the
spot consumed, §2.5) · `left_at null`. Unique `(task_id, user_id)`.

### 5.5 Schema — Messages, Attachments & Activity
**`message`** — the task thread (user comments + system events), **one-level threadable**.
`id` · `task_id` · `kind (comment | system)` · `sender_user_id uuid null` (null = system) ·
`parent_message_id uuid null` (a **reply**; CHECK: parent must be top-level → no
reply-to-a-reply) · `submission_id uuid null` (set when the message *is* a submission event,
so its thread = that submission's discussion) · `body text` (markdown for comments;
structured for system) · `lifecycle_state` · `retired_at` · `created_at` (server ts →
ordering) · `edited_at null` · `version`. Index `(task_id, created_at)`.

**`attachment`** — file metadata; bytes live in object storage (§5.8).
`id` · `organization_id` · `message_id null` · `answer_id null` (**CHECK: exactly one set**) ·
`uploader_user_id` · `storage_key text` · `filename` · `content_type` · `byte_size bigint` ·
`kind (image|text|audio|model|other)` · `checksum` · `lifecycle_state` · `retired_at` ·
`created_at`. *No attachment-level versioning — a revised deliverable is a **new submission
version** (§2.6); message attachments don't version. (Resolved — was an Open Q.)*

**`activity`** — **org-level** append-only audit: config changes + sync events (task
timelines now live in `message`, §2.7). **Lands in Slice 1** (load-bearing for invitation
audit there + config audit in Slice 2), not Slice 8 as the early draft had it. *Still the
one structure expected to grow; its size isn't in tension with the "stays small"
working-set assumption (that's about live rows, not log volume). Retention/partitioning (DB
Open Q) is the lever; tamper-resistance is convention-only in v1 (§6.3).*
`id (v7)` · `organization_id` · `actor_user_id uuid null` (null = system/sync) ·
`subject_type text` · `subject_id uuid` (polymorphic — no FK) · `verb text` (`config_changed`,
`role_synced`, `grant_changed`, `retired`, … — org-level verbs; task events are messages) ·
`payload jsonb` (structured non-PII facts only) · `source (patrice|integration|system)` ·
`source_connection_id uuid null` · `created_at`.
**Immutable** (no update/delete). Indexes `(subject_type, subject_id, created_at)`,
`(created_at)`. Covers config auditability (§2.8) and sync-removal tracking (§2.9); **task
history is the `message` thread**, not here.

**Payload PII discipline (resolved).** Activity payloads contain **IDs only — never PII
strings** (no `email`, no `displayName`, no other free-text snapshots of user data). The
`logActivity` helper (Slice 1) is the only entry point and Zod-validates each verb's
payload against an ID-shaped/structured-fact schema. PII rendering is done by joining to
current state at read time, with the tombstone fallback ("Former member" when
`organization.settings.anonymizeLabel`) for scrubbed users (§2.10). This sidesteps the
audit-log-vs-data-erasure conflict: there's no PII in `payload` to erase. (See §6.3
tamper-resistance for the separate, deferred enforcement of "append-only" itself.)

### 5.6 Schema — Sessions, Invitations, Tokens & Notifications
**`session`** — stateful, **identity-only** (§2.11).
`id` · `user_id` · `token_hash text unique` (opaque cookie token, stored hashed) ·
`auth_method (password|google)` · `created_at` · `last_seen_at` ·
`absolute_expires_at` · `idle_expires_at` (sliding) · `revoked_at null` · `ip inet null` ·
`user_agent text null`. Permissions are **not** stored here — resolved per request.
Deactivation/retirement cascades to revoke all of a user's sessions.

**`invitation`** — the account-creation path (§2.13). Token is a CSPRNG nanoid, stored hashed.
`id` · `organization_id` · `token_hash text unique` · `email citext null` ·
`intended_role_ids uuid[] null` · `passcode_hash text null` (bootstrap gate) ·
`max_uses int default 1` · `use_count int default 0` · `created_by uuid null` (null =
system/bootstrap) · `created_at` · `expires_at` · `revoked_at timestamptz null`.
*Status is **derived on read** (`CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN
use_count >= max_uses THEN 'exhausted' WHEN now() >= expires_at THEN 'expired' ELSE
'pending' END`) — no stored `status` column, no sweep job to flip `pending → expired`.
A partial unique index `(organization_id) WHERE created_by IS NULL AND revoked_at IS NULL`
keeps the bootstrap system-invitation singleton even under concurrent process boot.*
*API enforces `max_uses=1` in v1; the general shape is kept for future multi-use. Use-
consumption is **atomic** (FCFS); redemption is **POST-only** (§2.13).*

**`invitation_use`** — one row per redemption; the audit trail (survives invite retirement).
`id` · `invitation_id` · `created_user_id` · `used_at`.

**`auth_token`** — single-use email-verification & password-reset tokens (§2.2).
`id` · `user_id` · `kind (email_verification|password_reset)` · `token_hash text unique` ·
`created_at` · `expires_at` · `consumed_at null`. Consuming a `password_reset` triggers
the session-invalidation ("doubt") path.

**`notification`** — the in-app awareness pipe's persisted state (§2.12).
`id` · `organization_id` · `recipient_user_id` · `type text` (`assigned`,
`submitted`, `reviewed`, `message`, `invited`, `retired_block`, …) · `subject_type` ·
`subject_id` · `payload jsonb` · `read_at null` · `created_at`. Index
`(recipient_user_id, read_at, created_at)`. *In-app only — not email.* The push transport
(SSE/poll/WebSocket) is an API-tier choice; this table is the durable read-state backing it.

### 5.7 Relationship overview
```
organization ──1:*── app_user, role, division, team, task, invitation, grant,
                      attachment, activity, integration_connection
integration_connection ──1:*── external_identity, external_group_mapping
invitation ──1:*── invitation_use        (status is a derived enum on task — no table)
app_user ──1:*── user_identity (auth), session, auth_token, notification, external_identity
app_user ──*:*── role           (via user_role: source + source_connection + updated_at)
role ──(kind)── standalone | 1:1 division (inherent) | 1:1 team (inherent)
role ──1:*── grant              role ──*:*── external group (via external_group_mapping)
division ──1:1── inherent role  division ──1:*── task   division ──0:1── default questionnaire (via questionnaire.owner_division_id)
team ──1:1── inherent role      team ──1:*── task (optional)
task ──*:1── division (req), team (opt), requester   task ──1:1── questionnaire (its copy, via questionnaire.owner_task_id)
task ──1:*── task_claimant (slots), submission, message
questionnaire ──1:*── question     submission ──1:*── answer     answer ──0:1── attachment
submission ──self── prev_submission (version chain)
message ──self── parent_message (one level)   message ──0:1── submission   message ──1:*── attachment
status: derived (per-submission; task = lowest slot) — no table
activity ──poly──▶ org-level subjects (config/role/division/sync/…)
```

### 5.8 Object / blob storage
Attachment **bytes** (images, text deliverables, audio) live out-of-band, referenced by
`attachment.storage_key`. Candidates: an **S3-compatible** store (MinIO for self-host,
or any S3 vendor) behind a storage-port adapter; local-filesystem driver for tiny
installs. **Upload** is gated (`attachment:create`); **download** is a read — ungated in v1
(view-permissioning is tabled, §6.2). *Open: size limits, allowed types, content-type
validation, signed-URL vs proxied delivery.* (No attachment versioning — submission
versions cover revisions, §2.6.)

### 5.9 ORM / persistence layer
**Prisma** (decided — §4.10). Schema-relevant notes: `version` columns drive
**manual optimistic locking**; **soft-retire** filtering via Client Extensions; `citext`,
**partial indexes** (unique-on-active), and **GIN-on-JSONB** likely need hand-edited
migration SQL; `uuid v7` PKs via DB default; questionnaire `constraints` / answer `value`
JSONB typed at the API edge (§4.9), not in the ORM.

### 5.10 Migrations
Versioned, forward-only-by-default migrations via **Prisma Migrate** (§4.10), checked into
the repo and run on deploy; advanced Postgres features (partial indexes, citext, GIN-JSONB)
use hand-edited migration SQL where the Prisma schema can't express them. The deploy-time
bootstrap (§2.8) seeds the singleton `organization` + first admin.

### 5.11 Caching
Relocated to the API tier (§4.8) — an in-process, version-stamp-keyed read-shield, not a
database-tier component.

### Open Questions — Database
*All open DB items are rolled up in **§6**: GC mechanics (decided §2.10/§6.1);
activity-table partitioning (§6.2); answer/constraint JSONB storage shape (§6.5).*

---

## 6. Need-to-Address (Implementation Readiness)

*This section is the **canonical, whole-document rollup** of everything still open or
deferred — **every** open question lives here, each tagged with its most-relevant
section(s); the per-section "Open Questions" blocks are now just pointers into this list.
**6.1** blockers (gate build start) · **6.2** deferred-by-choice (future features) ·
**6.3** deferred concern-areas (ops/security) · **6.4** known gaps/risks · **6.5**
tier-local build choices (tool/library picks made when implementing a tier). Most blockers
are "**decide the rule**," not "build it all now."*

### 6.1 Implementation readiness — decisions & remaining build picks
*All **design** blockers are **resolved**. This records them (with section refs) and then
isolates the short list of **build-time** items still open — **none of which gate starting**.*

**Resolved — design decisions:**
- **Task / questionnaire / submission model** (§2.5/§2.6) — uniform task + per-task
  questionnaire (7 question types), per-claimant versioned submissions, claimant slots.
- **Status** (§2.5) — five-state engine carried by submissions; task status = lowest slot.
- **Action vocabulary** (§2.3) — closed `resource:verb`, CRUD-minus-Read + faces.
- **Cedar representation** (§4.4) — grants as template-link policies; cache the inputs.
- **Retired-entity treatment** (§2.10) — the one block/allow/degrade rule.
- **GC** (§2.10) — task-aggregate GCs as a unit (`activity` exempt); **lazy periodic sweep**
  with a configurable **grace period** (restore window), `EXISTS`-over-referrers, RESTRICT
  backstop, orphan-blob reconciliation.
- **ORM** (§4.10) — Prisma.
- **Identity reconciliation** (§2.2) — UUID identity; invite-only creation.
- **Protocol & query** (§4.1) — REST + OpenAPI; **keyset/cursor** pagination + **typed
  faceted filters**.
- **Notification transport** (§2.12/§4.5) — **SSE** (thin one-way signal; client reconciles).
- **Bootstrapping** (§2.8) — key-gated special invite; "no-effective-admin" trigger.

**Remaining — build-time (open, non-blocking):**
- **Infra-seam drivers** — object-storage (S3-compatible / MinIO, §5.8) and outbound-email
  (SMTP/provider, §2.2): pick a standard at build.
- **Cedar JS/TS binding maturity** (§4.4) — a prototyping validation, not a decision.

### 6.2 Safe to defer — future design points, not blockers
**Read/view permissioning** (no `read`/`view` action in v1 — the access vocabulary is
write-only; includes the deferred differential audit visibility, §2.7) · state-conditional
permissions · bulk-visibility predicates (tabled) · auto-merge concurrency ·
**user merge/combine** · free-text search (deferred — v1 is faceted-only, §2.5) · self-registration beyond invitations ·
service tokens / API keys · inter-task relationships · sync deletion-propagation & live
multi-integration (the Discord integration itself is deferred) · activity-table
partitioning · **2FA / MFA** for the account system · **invite↔verified-email binding**
(the prevention upgrade, §2.13 — note email *verification* itself is already v1, §2.2).
*Each is settled as the relevant slice is implemented; where detail exists it's in the cited
section body.* *(Config rollback was **declined**, not deferred — see the change log.)*

### 6.3 Deliberately deferred — whole concern areas (parked, not missed)
*These categories are out of scope for the design phase but are **acknowledged**, not
overlooked. Each becomes its own pass before or during the relevant build slice.*
- **Deployment & ops** — packaging, environments, backup/restore, upgrade/migration runs.
- **Secrets management (at rest)** — Patrice's own secrets live in **startup config**
  (§2.8) and integration *auth* is delegated to the provider, so v1 needs no secret-store.
  Deferred: a real backend (env/file/vault) + rotation for any future provider token Patrice
  must custody (`integration_connection.credentials_ref`, §5.2).
- **Security beyond auth** — rate-limiting the abuse-prone endpoints (invite, reset,
  login), upload safety/scanning, audit-log tamper-resistance (the `activity` table is
  append-only **by convention** in v1, not yet enforced), and **session-doubt signals**
  (§2.11 — what casts doubt on a session and triggers invalidation; revocation-UI priority
  vs. the deactivation cascade).
- **Failure & error semantics** — the contract for what a denial returns, how
  optimistic-lock conflicts surface to clients, queue retry/dead-letter behavior, and
  graceful degradation when outbound email or an integration is down mid-flow.
- **Observability & testing strategy** — logging/metrics/tracing, and the test approach
  for the **access engine** specifically (the riskiest component).
- **Frontend UX states** — error/empty/loading/offline conventions and the **design-system
  / component-library** choice (Angular Material vs. headless+custom) — a near-term build
  need once UI work starts.

### 6.4 Gaps / possible problems (known-shaky, watch during build)
*Decisions we've made to keep moving but that we suspect may bite — recorded so they're
revisited deliberately, not rediscovered in production.*
- **Questionnaire reuse beyond division defaults.** Testing teams will want **saved/
  reusable** questionnaires, not per-task re-authoring; v1 is per-task (seeded from the
  division default). Deferred.
- **Editing a questionnaire after a submission exists** is **disallowed** in v1 (locked at
  first submission) — the simplest rule. Richer "edit and re-map existing answers" handling
  gets high-level fast; deferred.
- **Departed-claimant submissions.** A submitted-then-left claimant's submission still needs
  resolving (approve / reject / retire-submission), and a *Returned* one can't be
  resubmitted by a departed claimant → cleared via reject/retire or manual complete. Handled,
  but the slot/replacement flow is worth watching in real multi-claimant use.
- **Account recovery from a lost sole auth method.** If a user's only login (e.g. Google)
  becomes inaccessible, v1 recovery is **admin-assisted** (re-invite / attach a method),
  plus standard password reset where a password exists. No self-service recovery for an
  external-only account — acceptable for v1, revisit if it bites.
- *(resolved)* Pending-invite fate on issuer state changes — see §2.13: passive on
  deactivation (rely on redemption-time re-validation), proactive auto-revoke on retirement,
  bootstrap immune. Moved out of "gaps."

### 6.5 Tier-local build choices (tool/library picks, made when implementing a tier)
*Design is decided; these are the "which library/shape" calls deferred to the build of the
relevant tier — listed here so §6 stays whole-document.*
- **Web — server-state tooling** (§3.3): TanStack Query (Angular) / `httpResource` / a thin
  custom layer.
- **Web — questionnaire rendering** (§3.4): a questionnaire → Reactive Form library vs. a
  hand-rolled mapping over the seven §2.6 question types.
- **Database — questionnaire/answer JSONB shape** (§5.4): how much of question `constraints`
  and answer `value` stays JSONB vs. structured columns; queryability of answers.
  *(Query **conventions** — keyset + faceted filters — are decided, §4.1.)*

### Change log
- *Initial skeleton.*
- *Expanded Guiding Context and full Design Goals (section 2) from design discussion;
  seeded tier sections 3–5 with derived architectural hints.*
- *Roles-as-central-currency, invitation-based provisioning, single access engine,
  GUID-identity-vs-face, and v1 optimistic locking; added §2.10.*
- *Resolved roles model (inherent 1:1 division/team roles, multiple roles per user,
  grant-level scope); reframed lifecycle around retirement + reference-counted GC, with
  retired data as a non-configurable hard-deny in the access engine (dropped the
  rectification framework).*
- *Added §2.11 Sessions (stateful, identity-only, HTTPS cookie, multi-session, admin +
  cascade revocation, absolute + sliding lifetime); added the three-layer permission
  performance model (cached version-stamped resolution, in-memory decisions, query-level
  bulk visibility); relocated caching to the API tier as a read-shield (§4.8).*
- *Flagged task forms & statuses for dedicated design passes. Expanded §4 into an API
  research survey: ports-&-adapters core, protocol options (lean REST+OpenAPI; tRPC ruled
  out by Rust-swap), TS/Rust framework candidates, session-store/OAuth/TLS options,
  access-engine build-vs-adopt, Postgres-backed queue, cache options, JSON-Schema form
  language, and Drizzle/Kysely query layer — all tentative.*
- *Decisions: **TypeScript** for the v1 API; **center Cedar** for point-decision policy
  (deny-by-default + forbid-overrides fits retired-as-hard-deny; runtime policies are
  schema-validated). **Tabled bulk visibility** (minor need for our uses). **ORM left
  open** ("find a proper ORM"). Expanded §4.8 caching guidance (what to cache, in-process
  vs Redis, ORM-managed vs explicit, version-stamp invalidation, build-the-seam stance).*
- *Database deep dive: rewrote §5 as a full schema mapping — conventions (uuid v7, org
  seam, lifecycle/retire+GC, optimistic `version`, config_version stamp, sync source/ts,
  JSONB), and tables across Identity & Org, Authorization & Structure, Work Tracking,
  Content/Attachments/Activity, and Sessions & Invitations, plus a relationship overview,
  object storage, migrations, and DB open questions.*
- *Generalized integrations in the data model: replaced Discord-specific columns/tables
  (`organization.guild_id`, `discord_account_link`, `role_discord_mapping`) with
  provider-agnostic `integration_connection`, `external_identity`, and
  `external_group_mapping` (an org may hold multiple connections; users/roles may carry
  multiple external links). Updated `user_role`/`activity` source provenance and the
  glossary/§2.9 to match. Data model only — API multi-integration complexity deferred.*
- *External-review pass: resolved the **retired-inherent-role / held-membership** case
  (inert grants + global baseline self-access) in §2.10/§2.3; added **invitation
  lifecycle** + **password reset/verification & the outbound-email dependency** (§2.2);
  stated **eligibility reads current Patrice state** (§2.4); added **un-assign/reassign**,
  **task withdrawal**, **pagination**, and a **named free-text-search decision** (§2.5);
  reconciled **comment edit/retire**, **UTC time authority**, **attachment access as an
  action**, and **differential audit visibility** (§2.7). Added **§2.12 Notifications**
  (in-app pipe, not email) with `notification`/`auth_token` tables (§5.6) and §4.5
  dispatch. Refreshed Open Questions. (Declined: notifications-as-undeferrable framing
  and config-rollback as premature.)*
- *Added §6 Need-to-Address (Implementation Readiness): blockers (form language, status
  model, action vocabulary, Cedar representation, retired-entity catalog, ORM, GC/aggregate
  boundary, identity reconciliation, protocol, bootstrapping, infra-seam drivers) vs.
  explicitly deferrable design points.*
- *Web tier decided: **Angular, signals-first**. Rewrote §3 — layered/segmented stance
  (presentation / application-behavior / data-access enforced by DI, FSD-style boundaries),
  signals-for-state + RxJS-only-at-I/O-edges, OpenAPI-generated client, JSON-Schema →
  Reactive Forms for the dynamic task forms, httpOnly-cookie auth with client guards as
  UX-only (server is the authority), and a signal-backed notifications client.*
- *De-duplicated the Open Questions: **§6** is now the canonical rollup of cross-cutting
  blockers/deferrals/gaps; the per-section blocks hold only tier-local items. **§2** trimmed
  to 2 (session security signals, pending-invite fate); **§4** now a pointer (all its items
  are cross-cutting — version-stamp granularity, bulk visibility, Cedar binding, sync
  mechanics); **§5** trimmed to 1 (task-details storage). Updated §6's framing and the §6.2
  footer to match.*
- *Per request, made **§6 the whole-document rollup**: every open item now lives in §6 with
  section tags, and **all** per-section "Open Questions" blocks (§2–§5) are now pointers.
  Added **§6.5 Tier-local build choices** (server-state tooling, dynamic-form rendering,
  task-details storage, filter-grammar); folded session-doubt-signals into §6.3 and
  pending-invite fate into §6.4.*
- *Invitations given a dedicated **§2.13** and settled: **bearer-token** model (mitigation +
  detection, not prevention — true prevention rides email-verification, §6.2); **nanoid**
  token (CSPRNG, unordered, hashed); **DB use-count-general but API single-use** (FCFS,
  consumed at account creation); 7-day default expiry; **privilege-bounded pre-assigned
  roles** (⊆ creator's grant scope, re-validated at redemption); **POST-only redemption**
  (anti-unfurl); **atomic** FCFS; full audit (`invitation_use`, `created_via_invitation_id`).
  Bootstrap is just a **passcode-gated system invite**. Schema (§5.6): `invitation` grows
  `max_uses`/`use_count`/`passcode_hash`, status `pending|exhausted|revoked|expired`, plus a
  new `invitation_use` table.*
- *Three short rulings **decided**: **(1) retired-entity treatment** (§2.10) — one rule:
  block mutations + new references, let existing references finish, degrade reads,
  revive-until-GC (no per-entity catalog); **(2) GC aggregate boundary** (§2.10) — task +
  comments/assignees/attachments GC as a unit, `activity` is never a refcount, roles/
  divisions/teams GC individually, users are retained; **(3) identity reconciliation**
  (§2.2) — `app_user` UUID is the sole identity, creation is invite-only (no
  auto-provisioning), email is a contact attribute not the join key. Added account-recovery
  edge (§6.4) and **2FA** + email-as-verification to the deferred list (§6.2); closed all
  three blockers.*
- *Config & bootstrap **decided** (§2.8): three layers — **startup** (env: infra + Patrice's
  own secrets; no DB-secret master key, integration auth delegated to the provider),
  **bootstrap** (seeds org + a *normal* default Admin role + first admin), **runtime** (DB,
  version-stamped). Bootstrap = a **key-gated special invite** (ephemeral key printed to
  stdout, dies with the process) resolving through the ordinary registration flow; trigger is
  **"no effective admin"**, which also serves as **lockout recovery** (idempotent re-bootstrap,
  adopts existing config). Kept the **administrability invariant** as a hard write-time guard
  refusing last-admin removal — no magic protected role. Closed the bootstrapping blocker.*
- *Status model **decided** (§2.5): a fixed, global, **derived** state machine
  (`Open → Claimed → Review ⇄ Revising → Approved`), non-editable, advanced only by
  transition actions. Cascade: removed the configurable `status` table + `status:*` and
  `task:change_status` actions; added `task:submit`/`task:review` (the `own` scope keys off
  assignee for submit, requester for review); `task.status_id` → derived `task.status` enum;
  self-review is a config flag; unclaim only from Claimed; retire is the sole cancelled exit.
  Reverses the earlier "not a state machine in v1." Added **§6.4 Gaps/Problems**, seeded with
  the multi-assignee × status-transition issue.*
- *Cedar representation **decided** (§4.4): **(ii) grants as Cedar policies (template-links)**
  — Cedar owns both role→grant matching and scope evaluation (its strength), via a small
  per-scope-shape template library (division/team as resource-in-group, `own` as a condition,
  role-scope for `grant_role`) projected from the grant table and schema-validated on edit;
  static policies for the retired `forbid` + baseline self-access. **Reframed the perf model**
  to cache Cedar's *inputs* (policy set + role entities), version-stamped, rather than a
  pre-resolved capability set — reversing the initial (i) lean after a "don't chew Cedar's
  food" challenge: at our scale Cedar's sub-ms eval makes pre-resolution redundant work + a
  second home for authz logic. Cost accepted: a policy-store projection synced to the grant
  table. Administrability invariant stays an app-level write-time guard, not a Cedar policy.
  Later clarified the **template-vs-link** distinction: a template is fixed, reviewable
  *logic* (names no role; `?principal`/`?resource` slots); a link is runtime *data* (a
  binding ≈ a grant row). Cedar policies are runtime-loaded data, not compiled — the schema
  (types) is the only compile-time artifact.*
- *Action vocabulary drafted (§2.3): closed **`resource:verb`** set on **CRUD-minus-Read**
  (`create`/`update`/`retire`) **+ faces** (a verb per field needing distinct authority).
  Collapsed claim/assign/unassign → `task:assign`, `request` → `task:create`; split user
  `deactivate` vs `retire`; added `task:change_requester`. **View tabled entirely**
  (wishlisted, §6.2) — also defers the differential audit visibility (§2.7). Extended
  `scope_kind` with `own` and a `role`/`scope_role_id` seam for scoped role-granting (§5.3);
  refreshed the `grant.action` examples. `task:change_status` granularity left as a marked
  gap pending the status pass.*
- *ORM **decided: Prisma** (§4.10/§5.9) — DX + mature migrations; recorded the build-time
  considerations (manual optimistic locking, Client-Extension soft-retire filter, raw SQL
  for partial-indexes/citext/GIN-JSONB, edge JSON validation). **Deprioritized the
  Rust-swap** as a design driver (Cedar JS bindings + Prisma TS schema deepen TS-coupling —
  growing cost, narrowing benefit): reframed the Guiding-Context principle, §4.0/§4.1/§4.2,
  added a non-goal, trimmed "Rust equivalent" asides. Ports-&-adapters and the
  language-neutral contract are **kept on their own merits** (tier boundaries, testability,
  external artifact), not for portability.*
- *Committed **REST + OpenAPI** as the API contract (§4.1, decided): authz-fit with Cedar
  (one endpoint = one check), operational simplicity, language-neutral artifact. Explicitly
  **not TS-coupled** — OpenAPI spec is the source of truth, never TS types (tRPC/shared-types
  rejected for killing the Rust-swap and the tier boundary); code-first (emit OpenAPI from
  Zod/TypeBox) is fine. Removed the protocol blocker (§6.1) and §4 open question; un-hedged
  §3; added the contract principle to Guiding Context. Recorded the **~200 users / ~100k
  tasks** scale envelope.*
- *Second review pass: pushed the bulk-visibility tabling into the load-bearing prose
  (§4.4 perf model, §4.1 rationale); reconciled §2 "architecture-free" framing; resolved
  comments to **flat-v1** (parent_comment_id a reserved seam); reframed `is_terminal` →
  `is_done_like` (display hint, not a transition); added the **administrability invariant**
  (§2.8); stated the **notification delivery guarantee** (durable table + best-effort
  transport + reconcile-on-connect, §2.12); generalized residual Discord (§2.2 principle,
  §5.1 sync-facts); marked `grant.action` provisional; fixed config-rollback mis-placement;
  added **§6.3 deliberately-deferred concern areas** (ops, secrets, security-beyond-auth,
  failure semantics, observability/testing, FE UX states) so absences read as parked, not
  missed; noted the requested-vs-claimed state decision; hedged §3's protocol assumption;
  reconciled the activity-table growth tension.*
- *Consistency pass: refreshed the stale "tiers are thin/undecided" framing (top note +
  §4 intro) to reflect committed decisions; moved cache off the guiding-context topology
  string to the API tier; propagated the integration generalization into the guiding
  context, topology diagram, glossary (User/Activity), §2.8, §4.0/§4.3 (Discord → provider-
  agnostic adapters); fixed the dangling "cross-cutting concerns" reference (→ §4.5/§6.1);
  reconciled §2.5 list views with the tabled bulk-visibility (faceted, not permission-
  scoped) and dropped predicate-visibility from the §4 principles; clarified Google as the
  only external **auth** provider.*
- ***Task model remodel*** *(replaces "task forms"): **uniform task** + an always-present
  **questionnaire** (7 question types with qualities) seeded from a **division default**,
  customizable per-task for testing, **locked at first submission**; **submissions** =
  versioned per-claimant answers (scalar or resource); **claimant slots/openings** (division
  default, lockable, close-to-claims, leave/replace rules). **Status unified**: the
  five-state engine is carried by **submissions**, task status = **lowest among slots**
  (single-claimant unchanged; whole-submission→Review falls out); per-submission
  review/return/reject/retire + manual complete. **Comments → messages** (user + system,
  one-level threading; notifications derive from, but aren't, messages; `activity` narrows to
  org-level). Updated glossary, §2.3 actions (`submit`/`review`/`retire_submission`/`complete`/
  `configure_questionnaire`/`manage_claims`; `message:*`), §2.4–§2.7, §3.4, §4.9, and the
  schema (dropped `task_form_template*`/`details`; added `questionnaire`/`question`/
  `submission`/`answer`/`message`; reshaped `task`/`division`/`attachment`/`activity`).
  Closed the §6.1 task-form blocker; refreshed §6.4/§6.5.*
- *Renamed §6.1 to "Implementation readiness — decisions & remaining build picks" (decided
  list vs. short open list). Settled three build items: **notification transport = SSE**
  (one-way thin signal; no two-way need; §2.12/§4.5/§3.6); **query conventions = keyset/
  cursor pagination + typed faceted filters** (uuidv7-as-cursor, index-backed; §4.1);
  **GC mechanics = lazy periodic sweep** (no eager counters) with a configurable **grace
  period** (restore window), `EXISTS`-over-referrers, RESTRICT backstop, orphan-blob
  reconciliation, run on the §4.5 worker (§2.10).*
- *Dropped the redundant `questionnaire.owner` column (ownership read from the back-reference).*
- *Resolved retired-user handling (§2.10/§5.2): **scrub-in-place to a tombstone** on full
  retirement (keep GUID + last `display_name`, null PII, purge satellites) — **no separate
  table** (would break the user FK graph); history-less users GC fully; re-join = fresh
  account; this is also the **GDPR-style data-erasure** path (anonymize-label is a per-org
  option). Added **user merge/combine** to §6.2 (future).*
- *Consistency pass after the remodel: fixed second-order stragglers — §1.1 ("form differs
  by division" → questionnaire; assigned → claim), guiding-context action list & "both code
  tiers", §2.3 baseline self-access (claimed), §2.8 + §5.2 ("assignment cardinality" →
  claimant openings / division defaults), §2.12 awareness layers (message thread +
  notification rows, not "activity feed"), §2.10/§6.1 GC children, optimistic-lock list,
  and renamed `task_assignee` → `task_claimant`.*
- *Cleared resolvable §6.2 items: **attachment versioning closed** (submission versions cover
  revisions, §5.5/§5.8); **version-stamp granularity decided org-wide** (§4.3/§5.1);
  **inter-task & self-registration confirmed out of v1** (stay deferred); **email entry split**
  — verification is v1 (§2.2), only invite↔verified-email binding is deferred (§2.13). Free-text
  search left as the one open §6.2 product decision.*
