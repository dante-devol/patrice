# Ubiquitous Language

The single cross-tier index of Patrice's domain vocabulary. It **consolidates** terms
that today live across `docs/ARCHITECTURE.md §2.1` (canonical entities), `docs/ARCHITECTURE.md §2.3`
(the action vocabulary), `api/CONTEXT.md` (API-tier load-bearing terms), and `web/CONTEXT.md`
(web-tier terms). Where a term has a canonical home, this file points there rather than
forking the definition — see **Flagged ambiguities** for why a fourth glossary needs that discipline.

## Actors & identity

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **User** | The sole canonical Patrice identity (`app_user`, a UUID), decorated with the **Roles** it holds. | Account, Login, Member (use Membership for the relation) |
| **Identity** | An authentication link on a User (`user_identity`: email/password or Google `sub`) — a method of proving you are a User, never the User itself. | Account, Login, Credential |
| **Verified Identity** | An Identity with `verified_at IS NOT NULL`; Google starts verified, password verifies by email token, bootstrap auto-verifies. | Confirmed Email, Validated Account |
| **Email** | A unique-per-org *contact attribute* on a User — never the join key between an invite and an auth method. | Account, Username |
| **Effective Admin** | An *active* User holding ≥1 `permit` grant on `{grant,role}:{create,update,retire}` at `scope_kind='global'`; scoped grants don't count. | Admin, Org Admin (those name the role, not the predicate) |

## Organization structure

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Organization** | The singleton owner of all data and configuration in a deployment. | Tenant, Workspace, Account |
| **Role** | The authorization atom; a User may hold many, and grants accumulate across them. | Group, Permission Set (Discord roles are external groups, not Roles) |
| **Inherent Role** | The Role auto-bound 1:1 to a Division or Team whose possession *is* membership and whose grants are scoped to it. | Auto Role, Group Role |
| **Membership** | A User's belonging to a Division or Team — equivalent to holding that group's Inherent Role. | Assignment, Enrollment |
| **Division** | The core axis of *labor* (Writing, Art, Testing, Leadership…); owns an Inherent Role, a default Questionnaire, and acts as a permission scope. | Department, Category |
| **Team** | A content-facing grouping (e.g. "USA") that owns an Inherent Role and *may* restrict who claims its tasks; subdivisions are modeled as Teams. | Squad, Subdivision, Group |
| **Integration Connection** | A configured link from the Organization to one external provider workspace (Discord first; a Discord workspace is a **Guild**). | Integration (the machinery), Plugin |

## Authorization

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Action** | A closed `resource:verb` string from the fixed vocabulary in `§2.3`; admins grant actions but cannot invent them. | Permission, Capability |
| **Grant** | A configuration row attaching an Action to a Role at a Scope Shape — the *source* the engine projects, not the enforcement. | Permission, Policy |
| **Scope Shape** | One of the five `grant.scope_kind` enums: `global`, `specific_group`, `own_group`, `own`, `role`. | Scope Type, Permission Scope |
| **Own Family** | The four `own` templates the projector binds — `own_as_requester` / `own_as_claimant` / `own_as_sender` / `own_as_uploader` — surfaced in the matrix UI as a single **own**. | Owner Templates, Ownership Policies |
| **Cedar Policy** | A projected rule the Cedar engine evaluates (the matrix compiled to policy text); distinct from a Grant, which is its source row. | Permission, Rule |
| **Verdict** | The engine's per-request permit/deny decision over cached inputs — the *output*, never a stored row. | Permission, Access |
| **Baseline Self-Access** | The static Cedar permit for `user:update` on `self == principal`, so a retired/inert role can never lock a User out of their own account. | Self Permission, Own Profile Access |
| **Retired-as-Hard-Deny** | The static Cedar `forbid` denying any Action whose target or actor is `lifecycle_state='retired'`, overriding any permit. | Retirement Block, Retired Forbid |
| **Claim Eligibility AND-Composition** | The rule that `division.restrict_claims` and `team.restrict_claims` are AND-composed, evaluated in Cedar via `task:assign @ own_as_claimant`. | Membership Check, Eligibility Rule |

## Tasks & questionnaires

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Task** | The uniform unit of tracked work — a Division (required), optional Team, requester, description, claimant slots, a Questionnaire, a derived Status, and a Message thread. | Ticket, Job, Item |
| **Requester** | The User who requested a Task (the `own_as_requester` owner relation; reviews submissions). | Owner, Author, Creator |
| **Claimant** | A User who claimed a Task's slot (the `own_as_claimant` owner relation; submits answers). | Assignee, Worker |
| **Claimant Slot** | One opening on a Task that a Claimant fills; the unit the Status Min-Rule reads. | Seat, Position |
| **Opening** | A claimant slot that is unfilled and still open to claims. | Vacancy, Slot (use Claimant Slot for the general term) |
| **Counted Slot** | A claimant slot that contributes to the Status Min-Rule — excludes rejected submissions and closed-unfilled spots. | Active Slot, Contributing Slot |
| **Questionnaire** | The structured ask a Task carries — an ordered list of typed Questions, seeded from the Division default and locked once any Submission exists. | Form, Survey |
| **Question** | One Questionnaire prompt of a fixed type (Detail-Text · Multiline · Text · Numeric · Dropdown · Radio · Attachment) with qualities (range, options, filetypes, required). | Field, Prompt |

## Submission & review lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Submission** | A Claimant's answers to the Questionnaire, one per Claimant, carrying a per-submission review status. | Response, Entry |
| **Answer** | A single Claimant response to one Question — a scalar or an Attachment resource. | Value, Field |
| **Submission Number** | The `submission_no` resubmission counter (v1, v2, v3), part of the row's identity. | Version (collides with the lock), Attempt, Iteration |
| **Status** | The derived lifecycle enum `Open · Claimed · Revising · Review · Approved`, carried by Submissions; non-editable. | State, Phase |
| **Status Min-Rule** | The function setting a Task's Status to the *lowest* state among its Counted Slots, reaching Approved only when every Counted Slot is Approved and at least one exists. | Status Aggregation, Status Roll-Up |
| **Empty Contributing Set Floor** | The rule that an empty Counted Slot set yields `status_cache='claimed'`, never a vacuous Approval. | Empty-Set Status, Vacuous Approval Block |
| **Manual Complete** | The `task:complete` Action forcing a Task to Approved regardless of submission states. | Force Approve, Bypass |
| **Message** | A task-thread entry — either a User comment or a senderless system message — one-level threadable (only top-level messages host threads). | Comment, Post (Message covers both kinds) |
| **Attachment** | A file in object storage referenced by exactly one Message or one Answer. | Upload, File, Blob (Blob is the stored object, Attachment is the reference) |

## Entity lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Retire** | The soft-delete Action — sets `lifecycle_state='retired'` and `retired_at`; the entity stays referenceable but becomes a hard deny. | Delete, Soft-Delete, Archive |
| **Revive** | The reverse of Retire, allowed only during the Grace Period; each `*:revive` is its own separately-granted Action. | Restore, Undelete |
| **Deactivate** | The in-life, reversible disabling of a User (distinct from Retire). | Suspend, Disable, Retire |
| **Reactivate** | The reverse of Deactivate (`user:reactivate`); distinct from `user:revive`. | Restore, Enable, Revive |
| **Grace Period** | The configurable window after `retired_at` during which Revive is allowed and GC will not collect. | Retention Window, Soft-Delete TTL |
| **GC** | Garbage Collection — the permanent reference-counted collector that deletes an aggregate once past Grace Period with no live references. | Cleanup, Purge, Delete |
| **Scrub-in-Place** | The permanent User-erasure path keeping the `app_user` row (`id` + `display_name`) while purging PII and satellites and auto-revoking issued invitations. | User Deletion, Account Removal |

## Identity provisioning

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Invitation** | A single-use, expiring bearer-token link that resolves to a new base User on redemption — the only account-creation path. | Signup, Registration |
| **Bootstrap Mode** | The server state where no Effective Admin exists; exposes a passcode-gated system invitation and closes the instant an Effective Admin appears. | Setup Mode (Setup is the page name) |
| **Bootstrap Key** | The ephemeral CSPRNG passcode for the system invitation — printed to stdout, never persisted, dies on process exit. | Setup Token, Admin Key |

## Cross-cutting

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Activity** | The org-level *immutable audit log* of configuration changes and sync events — IDs only, never PII. | Event Log, History, Timeline (task timelines are Messages) |
| **Activity Payload Discipline** | The rule that `activity.payload` carries IDs only, Zod-validated per-verb by `logActivity`. | Audit Privacy Rule |
| **Config Version** | The monotonic `organization.config_version` that bumps on any role/grant/retirement/settings change and keys the Cedar input cache; read fresh from DB per request. | Cache Generation, Schema Version |
| **PubSubPort** | The seam wrapping SSE fan-out (in-process adapter v1, `LISTEN/NOTIFY` post-v1) so HA is a deployment change, not a redesign. | Event Bus, Notifier |
| **Questionnaire Renderer** *(web)* | The component family that walks the seven Question types in **Authoring** mode (build the question set) or **Answer** mode (fill it in). | Question Form, Survey Component |
| **Permission Reflection** *(web)* | The UX-only display of what the current User may do — reflects the API, never enforces; a reflected `false` is a hint and the API may still 403. | Permission Check, Authorization (imply enforcement) |

## Relationships

- An **Organization** owns many **Roles**, **Divisions**, **Teams**, and **Users** (one Organization per deployment).
- A **Division** and a **Team** each own exactly one **Inherent Role**; holding it *is* **Membership**.
- A **User** holds zero or more **Roles**; a **Grant** attaches one **Action** to one **Role** at one **Scope Shape**.
- A **Task** belongs to exactly one **Division**, optionally one **Team**, and has one **Requester** and zero or more **Claimants** filling **Claimant Slots**.
- A **Task** carries one **Questionnaire** of ordered **Questions**; each **Claimant** produces one **Submission** of **Answers**.
- A **Task's Status** = the **Status Min-Rule** over its **Counted Slots**; an empty Counted Slot set hits the **Empty Contributing Set Floor**.
- An **Attachment** references exactly one **Message** or one **Answer** (never both).
- **Retire → Grace Period → GC** is the lifecycle for entities; **Deactivate → Reactivate** is the parallel in-life arrow for **Users**; **Scrub-in-Place** is the terminal erasure for Users.

## Example dialogue

> **Dev:** "When a **Claimant** resubmits after a return, do we bump `version`?"

> **Domain expert:** "No — resubmission increments the **Submission Number** (`submission_no`), which is part of identity. `version` is the optimistic lock; it bumps on *every* review write, including the return that sent them back."

> **Dev:** "And once the new Submission lands, the **Task Status** recomputes?"

> **Domain expert:** "Right — the **Status Min-Rule** takes the lowest state across **Counted Slots**. A returned slot drops the Task back to Revising even if another slot is Approved. And if every Claimant gets rejected and claims are closed, you don't get a vacuous Approved — the **Empty Contributing Set Floor** pins it to Claimed so the **Requester** has to act."

> **Dev:** "If the Requester then retires the whole Task, can they get it back?"

> **Domain expert:** "Within the **Grace Period**, yes — **Revive** is its own granted Action. Past that, **GC** collects the aggregate. Note Revive is for *retired* entities; a disabled User is **Reactivate**, a different arrow."

> **Dev:** "So who's allowed to review? Is that an **Admin** thing?"

> **Domain expert:** "Careful with 'Admin.' Reviewing is the `task:review` **Action**, usually scoped `own_as_requester`. The **Effective Admin** predicate is something else entirely — it's the bootstrap/administrability count, not a role anyone *is*."

## Flagged ambiguities

- **The glossary lives in four places now.** Canonical entities are in `docs/ARCHITECTURE.md §2.1`, the action vocabulary in `§2.3`, load-bearing terms in `api/CONTEXT.md`, web terms in `web/CONTEXT.md`, and *this* file indexes all of them. **Recommendation:** treat the per-tier CONTEXT files plus `§2.1`/`§2.3` as the source of truth and this file as a navigable consolidation; when `docs/ARCHITECTURE.md` is decomposed, fold `§2.1` into the CONTEXT files and keep this index as the cross-tier entry point. Do not let definitions drift between the four — edit the canonical home, then re-sync here.
- **"Admin" is overloaded three ways.** It names (1) the *Org Admin role*, (2) a division-scoped admin role ("a Writing admin ≠ an Art admin"), and (3) the **Effective Admin** *predicate* that drives bootstrap and the administrability invariant. Use **Effective Admin** for the predicate and name the specific Role otherwise; never bare "Admin" in a spec.
- **"version" collided with the resubmission counter.** `submission.version` is the optimistic lock; the resubmission counter is the **Submission Number** (`submission_no`). These were a single word once and must stay split.
- **"Permission" is doing four jobs.** It has been used for the **Action**, the **Grant** row, the Cedar **Policy**, and the engine **Verdict**. Pick the precise term; reserve "permission" for informal prose only, and never in schema or API names.
- **Two audit logs, not one.** **Activity** is the *org-level config/sync* log (IDs only); a Task's own history is its **Message** thread (system messages). Don't call the Message thread an "audit log" or expect config changes to appear in it.
- **"Account" conflates User and Identity.** A **User** (`app_user`) is the canonical identity; an **Identity** (`user_identity`) is one authentication method linked to it; **Email** is a contact attribute, not the join key. "Account" blurs all three — avoid it.
- **"Slot" is ambiguous.** Prefer **Claimant Slot** for the general unit, **Opening** for an unfilled-and-open one, and **Counted Slot** for one that feeds the Status Min-Rule.
