# Ubiquitous Language

The single cross-tier index of Patrice's domain vocabulary, matching the redesigned system
described in [`docs/architecture.md`](docs/architecture.md). The action vocabulary itself is
`api/src/access/actions.ts`; tier-specific terms are in `api/CONTEXT.md` and `web/CONTEXT.md`.

## Actors & identity

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **User** | The sole canonical Patrice identity (`app_user`, a UUID), decorated with the **Roles** it holds. | Account, Login, Member (use Membership for the relation) |
| **Identity** | An authentication link on a User (`user_identity`: email/password or Google `sub`) — a method of proving you are a User, never the User itself. | Account, Login, Credential |
| **Verified Identity** | An Identity with `verified_at IS NOT NULL`; Google starts verified, password verifies by email token, bootstrap auto-verifies. | Confirmed Email, Validated Account |
| **Email** | A unique-per-org *contact attribute* on a User — never the join key between an invite and an auth method. | Account, Username |
| **Effective Admin** | An *active* User whom Cedar permits every governance action (`grant:{create,update,delete}`, `role:{create,update,retire}`) org-wide; the admin floor keeps at least one. | Admin, Org Admin (those name the role, not the predicate) |

## Organization structure

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Organization** | The singleton owner of all data and configuration in a deployment. | Tenant, Workspace, Account |
| **Role** | The authorization atom: it holds Grants, and a User may hold many. An **Org Role** is held org-wide; a **Unit Role** is held at a division or team. Belonging to a unit is a Membership. | Group, Permission Set (Discord roles are external groups, not Roles) |
| **Unit Role** | A Role assigned to a User *at* a Division or Team (a Unit Role Assignment). Its grants use the `assigned` scope and apply only there; a division assignment covers its single-division teams. Project lead is the seeded one. | Project Role, Scoped Role, Lead Role |
| **Unit Role Assignment** | One User holding one Unit Role at one Division or Team. Assigning adds Membership if missing; unassigning keeps it. | Membership (that grants nothing), Appointment |
| **Assignable by leads** | A Unit Role flag: people who hold `*:assign_roles` through a unit role may assign it. Admins can assign any Unit Role. | Delegable, Lead-grantable |
| **Membership** | A User's belonging to a Division or Team (a `membership` row). It grants nothing by itself; `own_division`/`own_team` scopes and claim restrictions read it. | Assignment, Enrollment, Inherent Role (gone) |
| **Division** | The core axis of *labor* (Writing, Art, Testing…); keeps a Template Library, may allow Custom Templates, and is a permission scope. | Department, Category |
| **Team** | A grouping that **supports** one Division, several, or all of them (e.g. "USA" for Writing and Art) and *may* restrict who claims its tasks. Division authority reaches it only while it supports exactly that one Division. | Squad, Subdivision, Group |
| **Integration Connection** | A configured link from the Organization to one external provider workspace (Discord first; a Discord workspace is a **Guild**). | Integration (the machinery), Plugin |

## Authorization

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Action** | A closed `resource:verb` string from the fixed vocabulary in `§2.3`; admins grant actions but cannot invent them. | Permission, Capability |
| **Grant** | A configuration row attaching an Action to a Role at a Scope Shape — the *source* the engine projects, not the enforcement. | Permission, Policy |
| **Scope Shape** | One of `grant.scope_kind`: `global`, `specific_division`, `specific_team`, `own_division`, `own_team`, `own`, `role`. | Scope Type, Permission Scope |
| **Own** | What an `own` grant checks for its action: an owner relation (`requester`, `sender`, `uploader`, `owner`), `involved` (requested it or holds a seat), `seated`, or `self`. Never "could claim it": seeing and claiming other tasks takes a division, team or assigned grant (ADR 0021). | Owner Templates, Ownership Policies |
| **Cedar Policy** | A projected rule the Cedar engine evaluates (the matrix compiled to policy text); distinct from a Grant, which is its source row. | Permission, Rule |
| **Verdict** | The engine's per-request permit/deny decision over cached inputs — the *output*, never a stored row. | Permission, Access |
| **Baseline Self-Access** | The static Cedar permit for `user:update` on `self == principal`, so a retired/inert role can never lock a User out of their own account. | Self Permission, Own Profile Access |
| **Admin Floor** | The invariant that at least one Effective Admin remains; any change that could remove authority runs under it and is refused with `LAST_ADMIN`. | Last-admin check |
| **Claim Eligibility** | The rule that `division.restrict_claims` and `team.restrict_claims` are AND-composed: a restricted unit admits only its members. A static Cedar forbid on `task:assign`, so it holds whatever grant permits the claim (ADR 0021). | Membership Check, Eligibility Rule |

## Tasks & request templates

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Task** | The uniform unit of tracked work: a Division (required), optional Team, Requester, description, Openings, its own Task Questions, a derived Status, a Timeline and a Message thread. | Ticket, Job, Item |
| **Requester** | The User who requested a Task (the `requester` owner relation; reviews submissions). | Owner, Author, Creator |
| **Claimant** | A User holding a Seat on a Task (submits answers). | Assignee, Worker |
| **Seat** | One place on a Task that a Claimant occupies; leaving is allowed only before a first submission. A claimant's **tenure** starts when they take the seat. | Slot, Position |
| **Openings** | How many Seats a Task has (at least one). | Vacancy |
| **Current tenure** | The submissions a Claimant made since taking their Seat; only these count toward Status and resubmission. | Active Slot, Contributing Slot |
| **Template Library** | A Division's request templates; at most one is the default. A requester picks one when creating a task. | Form, Survey, Questionnaire |
| **Question** | One prompt of a fixed type (Detail-Text · Multiline · Text · Numeric · Dropdown · Radio · Attachment) with its constraints; edited by stable id. | Field, Prompt |
| **Custom Template** | Questions a requester writes for one task, allowed by the division setting or a `task:compose_template` grant. | Ad-hoc form |
| **Task Questions** | A task's own snapshot of questions (`task_question`); answers point here, so library edits never reach existing tasks. | Task copy |

## Submission & review lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Submission** | A Claimant's answers to the Task Questions, with a review state (`review`, `revising`, `approved`, `rejected`, `not_required`). | Response, Entry |
| **Answer** | A single Claimant response to one Question — a scalar or an Attachment resource. | Value, Field |
| **Submission Number** | The `submission_no` resubmission counter (v1, v2, v3), part of the row's identity. | Version (collides with the lock), Attempt, Iteration |
| **Status** | The derived task lifecycle `Open · Claimed · Revising · Review · Approved`; stored as `status_cache`, rebuildable from facts. | State, Phase |
| **deriveStatus** | The one rule for Status: a completed task is Approved; otherwise the lowest contribution over its Seats and open Openings (rejected and not-required submissions contribute nothing). | Status Aggregation, Status Roll-Up |
| **Empty set floor** | When no Seat or Opening contributes (say the only submission was rejected), Status is Claimed, never a vacuous Approved. | Vacuous Approval |
| **Completion** | A recorded, terminal fact (`completed_at`, `completed_by`): closes claims and marks outstanding submissions not required. | Force Approve, Bypass |
| **Message** | A User comment on a task thread, one-level threadable, optionally about a Submission. Deleted outright, or kept as an empty marker while it has replies. | Post, System message (now Timeline Entries) |
| **Timeline Entry** | A typed `domain_event` on a Task (claimed, submitted, evicted, completed…), rendered as its history; also the source of notifications. | System message, Event log |
| **Attachment** | A stored file on a Task, belonging to a Message or an Answer — or **pending** (neither) until its uploader's own submit claims it. | Upload, File, Blob (Blob is the stored object) |

## Entity lifecycle

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Retire** | Soft removal for tasks, users, divisions, teams, roles and integration connections: `lifecycle_state='retired'` until revived or collected. Other things are deleted outright with an audit row. | Delete, Soft-Delete, Archive |
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
| **Activity** | The org-level *append-only audit log*: configuration values and ids, never user-authored text. | Event Log, History, Timeline (task history is Timeline Entries) |
| **Activity Payload Discipline** | The rule that `activity.payload` is Zod-validated per verb and carries ids and configuration values, never user text. | Audit Privacy Rule |
| **Config Version** | The monotonic `system_settings.config_version`, bumped by any authorization change; keys the Cedar policy cache. | Cache Generation, Schema Version |
| **PubSubPort** | The seam wrapping SSE fan-out (in-process adapter v1, `LISTEN/NOTIFY` post-v1) so HA is a deployment change, not a redesign. | Event Bus, Notifier |
| **Request Template Renderer** *(web)* | The component family that walks the seven Question types in **Authoring** mode (build the question set) or **Answer** mode (fill it in). | Question Form, Survey Component |
| **Permission Reflection** *(web)* | The UX-only display of what the current User may do — reflects the API, never enforces; a reflected `false` is a hint and the API may still 403. | Permission Check, Authorization (imply enforcement) |

## Relationships

- An **Organization** owns many **Roles**, **Divisions**, **Teams**, and **Users** (one Organization per deployment).
- A **Team** supports one or more **Divisions**, or all of them (including ones created later); a **User** may hold **Memberships** in either, independently.
- A **Task**'s **Team** must support the **Task**'s **Division**.
- A **User** holds zero or more **Roles**; a **Grant** attaches one **Action** to one **Role** at one **Scope Shape**.
- A **Division** keeps a **Template Library**; a **Task** snapshots one template, or **Custom** questions, as its **Task Questions**.
- A **Task** belongs to exactly one **Division**, optionally one **Team**, and has one **Requester** and **Claimants** in its **Seats**.
- Each **Claimant** produces **Submissions** of **Answers**; **deriveStatus** turns the facts into the **Task's Status**.
- A **Task's** history is its **Timeline Entries**; its conversation is its **Messages**.
- An **Attachment** belongs to at most one **Message** or **Answer**; with neither it is pending.
- **Retire → Grace Period → GC** is the lifecycle for entities; **Deactivate → Reactivate** is the parallel in-life arrow for **Users**; **Scrub-in-Place** is the terminal erasure for Users.

## Example dialogue

> **Dev:** "When a **Claimant** resubmits after a return, do we bump `version`?"

> **Domain expert:** "No — resubmission increments the **Submission Number** (`submission_no`), which is part of identity. `version` is the optimistic lock; it bumps on *every* review write, including the return that sent them back."

> **Dev:** "And once the new Submission lands, the **Task Status** recomputes?"

> **Domain expert:** "Right — **deriveStatus** takes the lowest contribution across the **Seats**. A returned submission drops the Task back to Revising even if another is Approved. And if every Claimant gets rejected and claims are closed, you don't get a vacuous Approved — it stays Claimed so the **Requester** has to act. Only **Completion** makes it Approved for good."

> **Dev:** "If the Requester then retires the whole Task, can they get it back?"

> **Domain expert:** "Within the **Grace Period**, yes — **Revive** is its own granted Action. Past that, **GC** collects the aggregate. Note Revive is for *retired* entities; a disabled User is **Reactivate**, a different arrow."

> **Dev:** "So who's allowed to review? Is that an **Admin** thing?"

> **Domain expert:** "Careful with 'Admin.' Reviewing is the `task:review` **Action**, usually scoped `own` (the requester). The **Effective Admin** predicate is something else entirely — it's what the **Admin Floor** protects, not a role anyone *is*."

## Flagged ambiguities

- **"Admin" is overloaded three ways.** It names (1) the *Org Admin role*, (2) a division-scoped admin role ("a Writing admin ≠ an Art admin"), and (3) the **Effective Admin** *predicate* that drives bootstrap and the administrability invariant. Use **Effective Admin** for the predicate and name the specific Role otherwise; never bare "Admin" in a spec.
- **"version" collided with the resubmission counter.** `submission.version` is the optimistic lock; the resubmission counter is the **Submission Number** (`submission_no`). These were a single word once and must stay split.
- **"Permission" is doing four jobs.** It has been used for the **Action**, the **Grant** row, the Cedar **Policy**, and the engine **Verdict**. Pick the precise term; reserve "permission" for informal prose only, and never in schema or API names.
- **Two records, not one.** **Activity** is the *org-level configuration* log; a Task's own history is its **Timeline Entries**. Neither is the Message thread, which is conversation only.
- **"Account" conflates User and Identity.** A **User** (`app_user`) is the canonical identity; an **Identity** (`user_identity`) is one authentication method linked to it; **Email** is a contact attribute, not the join key. "Account" blurs all three — avoid it.
- **"Slot" is retired.** Say **Seat** for a claimant's place and **Openings** for how many a Task has.
