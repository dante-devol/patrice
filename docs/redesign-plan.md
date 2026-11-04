# Patrice: Redesign Implementation Plan

> **Status: implemented** (Phases 0–8, November 2026). The result is described in [architecture.md](architecture.md), with decisions in [adr/](adr/) and the cutover rehearsal in [cutover-rehearsal.md](cutover-rehearsal.md).

> **What this is.** The single plan for re-architecting Patrice. It turns the findings and decisions in the four review documents into ordered, concrete work:
> - [current-architecture.md](current-architecture.md): how the system is built today
> - [current-design-problems.md](current-design-problems.md): root causes R1–R11 and defects D1–D29
> - [current-design-decisions.md](current-design-decisions.md): the decision register, with verdicts
> - [intent-vs-reality.md](intent-vs-reality.md): the owner's direction decisions (§1) and requirements session (§6)
>
> It adds one new requirement that isn't in those documents: **request templates become a per-division library, plus custom templates** ([§3](#3-new-requirement-request-template-library-and-custom-templates)).
>
> Drafted 2026-11-02 on `docs/architecture-review`. Where this plan and the review documents disagree, this plan is newer; where it and the owner's decisions disagree, the decisions win.

---

## How to read this

| § | Section | What it gives you |
|---|---|---|
| 1 | [Summary](#1-summary) | The plan on one page |
| 2 | [Approach and ground rules](#2-approach-and-ground-rules) | How the work is done, and what holds across every phase |
| 3 | [New requirement: request templates](#3-new-requirement-request-template-library-and-custom-templates) | The spec for the template library and custom templates |
| 4 | [Phases](#4-phases) | Phases 0–8, each with its work items, what it fixes and when it's done |
| 5 | [Decisions this plan proposes](#5-decisions-this-plan-proposes) | Four design points the reviews left open, with the answer this plan assumes |
| 6 | [Traceability](#6-traceability) | Every root cause and defect, mapped to the phase that removes it |

---

## 1. Summary

**Shape of the work.** Refactor in place, one phase at a time. Patrice stays deployable after every phase, and each phase ships its own migrations. Nothing is a big-bang rewrite. The stack doesn't change: NestJS, Prisma, Postgres 18, pg-boss, Cedar, Angular.

**Order.** Foundations first, because almost every defect traces back to the missing domain layer (R3). Authorization and membership come next, because the work model, the template library and Discord all depend on them.

| Phase | Name | Core outcome | Depends on |
|---|---|---|---|
| 0 | Foundations | Domain layer and unit of work; Zod → OpenAPI → generated client; drop `organization_id`; typed settings; error catalog | – |
| 1 | Identity & accounts | Generic OIDC slot; login CSRF fixed; self-service account; session list and revoke; no plaintext tokens in jobs | 0 |
| 2 | Membership & authorization | First-class membership; read actions; authorize inside domain operations; admin floor as a real invariant; seeded Admin and Member; `requireDiscordLink` in the API | 0 |
| 3 | Lifecycle, events & audit | Undo cut to six entity types; one typed event outbox feeding audit, timeline and notifications | 2 |
| 4 | Work model & templates | Template library and custom templates (§3); settled slot rules; a stored completion fact; safe attachments | 2, 3 |
| 5 | Processes & background work | An explicit API vs worker composition; a queue that fails loudly; real retries; API → worker signals | 0 |
| 6 | Discord integration | ADR 0002 implemented as written; auto sync links; mapping-delete choice; worker-only key custody | 2, 3, 5 |
| 7 | Web client | Generated client, allowed actions and typed events adopted; merged with the UI branch | 0–6, incrementally |
| 8 | Cutover & documentation | Data migration verified, new architecture docs, old docs retired | all |

Phases 1 and 5 depend only on Phase 0, so they can run in parallel with Phase 2.

---

## 2. Approach and ground rules

### 2.1 How the work is done

- **In place, phase by phase.** Each phase is one or more PRs against `main`, each with its own migrations. Within a phase, work goes module by module: a module moves onto the domain layer and its tests move with it.
- **The HTTP surface changes deliberately.** From Phase 0 the contract is generated from Zod, so every response change shows up as a compile error in the web client, not as a runtime surprise. Until Phase 7, phases keep response shapes **additive** wherever they can (new fields, new endpoints) and fix the web client only as much as needed to keep it working.
- **Data is migrated, not dropped.** Every migration that reshapes data (dropping `organization_id`, membership, the template library, events) includes a data step and a test against a copy of the seeded dataset. *If no deployment holds real data, Phase 8's migration check reduces to re-seeding; say so before Phase 0 starts.*
- **Seeding stays on the HTTP API** (`api/scripts/seed.mjs`), so every invariant applies to seed data too. The seed script is updated in each phase that changes the API.

### 2.2 Rules that hold in every phase

These come straight from the owner's decisions and the "should survive" list. They aren't revisited during the work.

1. **Cedar owns policy.** Access decisions are Cedar decisions. TypeScript guards exist only for named exceptions, and each one carries a comment saying why it can't be a policy.
2. **Aggregates own invariants.** No service writes a table it doesn't own, and no business rule is checked anywhere except inside its aggregate.
3. **One unit of work per command.** One transaction holds the state change, its audit row, its domain events and its `config_version` bump, and runs the admin-floor check before commit (Phase 0 builds it; Phase 2 adds the floor).
4. **Single org, one API, one worker.** No multi-tenant columns. No multi-replica machinery. State moves into Postgres only where that's cheap.
5. **Keep what works.** Everything on the register's "should survive" list stays as it is: UUIDv7 keys, cursor pagination, opaque DB sessions, peppered token hashes, the pure validator, the pure reconciler, the Gateway doorbell, durable notifications with content-free pings, and so on.
6. **The web UI branch is out of scope.** Another branch is reworking the web interface. This plan touches the web client only where the API contract forces it (generated client, allowed actions, typed events, the template picker). The UI work is merged in Phase 7.

---

## 3. New requirement: request template library and custom templates

**Summary.** Today a division owns **at most one** request template, and every task deep-copies it at creation. The redesign separates templates from divisions (somewhat):
1. A division has a **library of several templates**. The requester picks one when making a request.
2. A division can **allow requesters to write their own template** for a request (a division setting).
3. A **grantable action** lets chosen roles write their own template **anyway**, even where the division setting is off.

Templates stay **owned by a division**. They aren't shared across divisions; a template can be copied into another division instead (see [§3.7](#37-out-of-scope)).

### 3.1 Today

| Fact | Where |
|---|---|
| `request_template` is owned by **exactly one** of a division or a task (two UNIQUE owner columns plus a CHECK) | [schema.prisma](../api/prisma/schema.prisma), `RequestTemplate` |
| A division has 0..1 template; task creation fails with `422 NO_DEFAULT_REQUEST_TEMPLATE` without one | [tasks.service.ts](../api/src/tasks/tasks.service.ts), `create` |
| The division template is edited with `PUT /divisions/:id/request-template`, gated by `division:update` (a borrowed action, register C3) | [request-templates.controller.ts](../api/src/request-templates/request-templates.controller.ts) |
| The task's copy is edited with `task:configure_request_template` until the first submission locks it; edits replace the question set wholesale (register E4, problems D6) | [request-templates.service.ts](../api/src/request-templates/request-templates.service.ts) |

### 3.2 Model

Split the two meanings of "request template" into two tables, so the owner XOR CHECK goes away.

| Table | Meaning | Key columns |
|---|---|---|
| `request_template` | A **library template** belonging to a division | `id`, `division_id` (FK, RESTRICT), `name`, `description`, `is_default`, `version`, timestamps |
| `request_template_question` | A question in a library template | `id` (stable), `request_template_id` (FK, CASCADE), `ordinal`, `type`, `prompt`, `required`, `constraints` |
| `task_question` | A question in **the task's own copy** | `id` (stable), `task_id` (FK, CASCADE), `ordinal`, `type`, `prompt`, `required`, `constraints`, `source_question_id` (nullable, no FK, provenance only) |
| `task` (new columns) | Where the task's questions came from | `source_template_id` (nullable FK, `ON DELETE SET NULL`), `template_origin` enum: `library` or `custom` |
| `division` (new column) | Whether requesters may write their own template | `allow_custom_templates boolean NOT NULL DEFAULT false` |

Rules:
- **At most one default per division:** a partial unique index on `(division_id) WHERE is_default`. The default is preselected in the picker. A division may have no default.
- **Template names are unique per division** (citext).
- **Answers reference `task_question`**, never a library question, so editing or deleting a library template can't break a submission (this removes the D6 class of crash).
- **A task's questions are a snapshot.** Editing a library template never changes existing tasks.
- **Library templates are hard-deleted, with an audit row.** They aren't in the six-type undo scope (§6.4 of intent-vs-reality), and tasks keep their snapshots, so nothing depends on them. `source_template_id` becomes null.
- **The empty template stays valid.** A template with no questions is a "coordination only" request, as today.

### 3.3 Authorization

All of these are Cedar decisions on the **Division** resource, following rule 2.2.1.

| Action (new) | Scopable | Gates |
|---|---|---|
| `request_template:read` | yes | Listing and reading a division's library (part of Phase 2's read actions) |
| `request_template:create` / `:update` / `:delete` | yes | Managing the library. Replaces the borrowed `division:update` (register C3) |
| `task:compose_template` | yes | Creating a task with a **custom** template in that division |

**The division setting is a static policy, not a TypeScript check:**

```cedar
// Custom templates are open to any requester in divisions that allow them.
permit (principal, action == Action::"task:compose_template", resource is Division)
when { resource.allowCustomTemplates };
```

So `task:compose_template` is permitted when **either** the division allows custom templates **or** a grant gives the action to one of the principal's roles. The second case is the "some roles may do this anyway" requirement. Because it's a normal Cedar decision, a `forbid` grant still overrides both, which keeps forbids meaning the same thing everywhere.

`task:compose_template` never stands alone: creating a custom-template task needs `task:create` **and** `task:compose_template` on the same division.

**Seeding (extends intent-vs-reality §6.6).** Admin gets all four new actions at global scope, as with every action. Member gets `request_template:read` and no library management. Member gets no `task:compose_template` grant: custom templates follow the division setting unless an admin grants otherwise.

### 3.4 API

| Endpoint | Action | Notes |
|---|---|---|
| `GET /divisions/:id/request-templates` | `request_template:read` | The picker list: id, name, description, `isDefault`, question count, and `allowedActions` on the division (includes `task:compose_template`, so the client knows whether to offer "Write my own") |
| `GET /request-templates/:id` | `request_template:read` | The full template, with questions |
| `POST /divisions/:id/request-templates` | `request_template:create` | Name, description, questions, optional `isDefault` |
| `PATCH /request-templates/:id` | `request_template:update` | Questions diffed by stable ID (register E4); `version` guards concurrent edits |
| `DELETE /request-templates/:id` | `request_template:delete` | Hard delete + audit |
| `POST /tasks` | `task:create` (+ `task:compose_template` for custom) | Body gains a required `template` field, below |
| `PATCH /divisions/:id` | `division:update` | Gains `allowCustomTemplates` |

The task-create body states the template choice explicitly:

```ts
template:
  | { kind: 'library'; templateId: string }   // must belong to the task's division
  | { kind: 'custom'; questions: QuestionInput[] }
  | { kind: 'default' }                       // the division's default; 422 TEMPLATE_REQUIRED if none
```

Errors: `TEMPLATE_NOT_IN_DIVISION` (422), `TEMPLATE_REQUIRED` (422), and the existing question-validation errors for custom questions.

**Saving a custom template to the library** needs no special endpoint. The client calls `POST /divisions/:id/request-templates` with the same questions, which needs `request_template:create`.

**The task's copy** keeps today's behaviour under `task:configure_request_template`: editable until the first submission, then locked. Edits diff by question ID, and once a question has answers it can't be deleted, only edited while unlocked.

### 3.5 Audit and events

Per intent-vs-reality §6.5: template **name**, `is_default`, `allow_custom_templates`, question **count and types** and `template_origin` are recorded as values (configuration). Question prompts and options are user-authored text and are recorded by ID only. `task.created` records `templateOrigin` and `sourceTemplateId`.

### 3.6 Migration

1. Each division's existing template becomes a library template named "Default", with `is_default = true`.
2. Each task-owned template becomes `task_question` rows with the **same question IDs**, so existing answers keep pointing at them; `template_origin = library`, and `source_template_id` is the division's new "Default".
3. `answer.question_id` is repointed to `task_question`; the old `request_template` and `question` tables are dropped.
4. `allow_custom_templates` defaults to false everywhere, so behaviour doesn't change until an admin turns it on.

### 3.7 Out of scope

- **Templates shared across divisions.** If they turn out to be needed later, the model extends with a nullable `division_id` (meaning org-wide) and a matching Cedar scope. Until then, copying covers the case.
- **Versioned library templates.** Tasks hold snapshots, so a template's history isn't needed to explain an old task.
- **The picker and template-authoring UI.** Phase 7 adds the minimum (a picker plus a "Write my own" path that reuses the existing authoring renderer); the UI branch owns the final design.

### 3.8 Done when

- A division can hold several templates; a requester can pick any of them, or the default, when creating a task.
- With `allowCustomTemplates` on, any requester who can create a task in the division can write their own questions. With it off, only principals granted `task:compose_template` can. A `forbid` grant blocks both.
- Editing or deleting a library template leaves every existing task and submission unchanged.
- E2E tests cover all three `template` kinds, the setting on and off, the grant, a forbid, and a template from another division (rejected).

---

## 4. Phases

Each phase lists its **work items**, what it **fixes** (problems-doc and register references), and when it's **done**.

### Phase 0: Foundations

**Summary.** Build the structure everything else stands on: a domain layer with a unit of work, a generated contract, and the removal of the multi-tenant seam and the untyped settings.

**Work items**
1. **Domain layer skeleton.** Introduce `domain/` (aggregates, domain services, ports) and `infrastructure/` (Prisma repositories, adapters). Aggregates: Task (with claims, submissions and its questions), User, Division, Team, Role (with grants), RequestTemplate, IntegrationConnection. Controllers call application services; application services call aggregates through repository ports.
2. **Unit of work.** One `UnitOfWork.run(cmd)` that opens the transaction, collects audit rows and domain events from aggregates, bumps `config_version` only when policy text changes, and commits. Phase 2 adds the admin-floor check; Phase 3 adds the event outbox. Every audit row is written inside the transaction (problems R3, activity rows written after commit).
3. **Optimistic locking.** Repositories do version-guarded updates on every aggregate root, as the old docs intended (register B7).
4. **Contract.** Zod schemas become the source of truth for requests and responses. Emit OpenAPI from them, and generate the Angular client from that (decision 1). Replace [`api.types.ts`](../web/src/app/core/api.types.ts) and the hand-written parts of [`api.service.ts`](../web/src/app/core/api.service.ts).
5. **Error catalog.** One typed catalog of error codes, exported in the contract. Map `P2003` and `P2025` to 409 and 404 instead of 500 (problems D27).
6. **Request boilerplate.** A `@CurrentUser()` decorator and a global auth guard replace the per-route `if (!req.user)` checks and the per-controller `AuthedRequest` interfaces.
7. **Drop `organization_id`.** Remove the column, its indexes and the `organization.singleton` row pattern from every table; settings move to typed tables (next item) (decision 6, problems R9, register B1).
8. **Typed settings and secrets.** Replace the `organization.settings` JSON with typed columns in a settings table. Secrets go in their own table with a purpose column and a per-purpose key. Remove the dead `RETIREMENT_GRACE_DAYS`; move `DISABLE_QUEUE` into the env schema (problems R10, register B12, D9).

**Done when** at least one aggregate (Division is the smallest) runs fully through the domain layer and unit of work; the web client builds from the generated client; no table has `organization_id`; `organization.settings` is gone.

### Phase 1: Identity & accounts

**Summary.** Fix the authentication defects and give users control of their own account.

**Work items**
1. **Generic OIDC/OAuth provider slot.** A `LoginProvider` port with Discord as its first adapter. Provider config (client ID, secret ref) lives in typed settings and secrets, not keyed off `SESSION_SECRET` (decision 7, register D9).
2. **Login CSRF.** Bind OAuth `state` to the browser with a short-lived, HttpOnly, SameSite=Lax cookie that holds the nonce, and check it on callback. Keep invite tokens out of `state`: `state` carries an opaque handle to a server-side pending-registration row (problems D3).
3. **Self-service account.** Change password (with the current password), change email (re-verify the new address before switching), add a password to a provider-only account, attach and detach sign-in identities, with the "last sign-in method" rule enforced in the User aggregate (problems D24, register D11).
4. **Sessions.** A session list for the user and `session:revoke` (own and global), as the old docs specified. Logout is gated by `session:revoke @ own`. The idle window slides at most once a minute (register D7, problems D18).
5. **No plaintext tokens in jobs.** The API enqueues "send verification email to user X". The worker mints the token, stores its hash and sends the email, so the job table never holds a bearer token (problems D12).
6. **Token and bootstrap fixes.** Consume verification and reset tokens inside the transaction that checks them (D18 race). Store the bootstrap passcode as a peppered hash like every other secret. Bootstrap runs only in the API (single API, so the rotate-per-replica issue disappears).
7. **Invitation bounds.** `expiresAt` must be in the future and at most a configured maximum (problems D27).

**Done when** the CSRF test (attacker's callback opened by a victim) fails to sign the victim in; a Discord-only user can add a password and then disconnect Discord; no row in `pgboss.job` contains a token.

### Phase 2: Membership & authorization

**Summary.** Separate membership from authority, put reads under Cedar, and make the admin floor impossible to bypass.

**Work items**
1. **Membership.** A `membership(user_id, unit_type, unit_id, source)` table, where `source` is `patrice` or `integration`. Remove inherent roles. Units become Cedar entity parents, so `own_division` and `own_team` scopes evaluate membership directly (decision 2, problems R5, register C7). *Needs the hierarchy decision in [§5.1](#51-division--team-hierarchy) first.*
2. **Migration from inherent roles.** Each inherent-role holder becomes a member. Each grant attached to an inherent role moves to a new ordinary role named after the unit, assigned to the same people, so nobody gains or loses access in the migration.
3. **Read actions.** Add `task:read`, `submission:read`, `message:read`, `attachment:read`, `request_template:read`, `user:read`, `division:read`, `team:read`, `role:read` and the others to the closed vocabulary. Restricted divisions restrict visibility as well as claims. Name lookups (users, divisions, teams) get a read action that Member holds, so the client stops showing UUIDs (decision 3, problems R1, register C9, C10, F5).
4. **Authorize inside domain operations.** Application services call `authorize(principal, action, entity)` with the entity they already loaded. Delete the route resolvers in [`authorize.decorator.ts`](../api/src/access/authorize.decorator.ts), the fabricated resource IDs and the revive-variant resolvers. One entity loader builds Cedar entities per request and caches the principal's roles and memberships for the request (problems R6, register C8, C14).
5. **List filtering.** List endpoints filter by visibility, computed from the principal's grants as query predicates and verified by Cedar on each returned row, so pagination stays correct.
6. **Allowed actions on reads.** Each entity response carries `allowedActions`, computed by Cedar. Remove the `inviteCreate` and `manageOrg` capability booleans (register C15).
7. **Governance actions target real entities.** `team:*`, `invite:*` and the role and grant actions are scoped to their real resource, so per-division administration can be expressed (register C3).
8. **Lifecycle checks leave Cedar.** "Is it retired?" checks move into aggregates. Cedar decides *who*. Remove the static retired hard-deny. Aggregates also block **new references** to retired entities: no granting a retired role, no granting roles to a retired user (register B13, problems D27).
9. **Admin floor as an invariant.** Before commit, the unit of work evaluates real Cedar decisions for the six governance actions against the post-change state, and refuses the change if no active user is still permitted all of them. That covers forbids, grant creation, division and team retire, integration revokes and unlink, because they all commit through the same unit of work (problems D2, D20, register C5, C12).
10. **Seeded roles.** Admin holds every action at global scope, and the seed is extended whenever an action is added. Member is seeded with the own-scoped work grants and is pre-assigned on new invitations (intent-vs-reality §6.6, problems D29).
11. **`requireDiscordLink` in the API.** A static Cedar `forbid` over the task-family actions (reads included) when the setting is on, at least one Discord connection is active, and the principal lacks a sync link to every active connection. A grantable `task:bypass_discord_gate` action exempts roles. The setting moves to a read the SPA can make as a non-admin (intent-vs-reality §6.2, problems D14).
12. **Leave depends on the seat.** `POST /tasks/:id/leave` is its own action, `task:leave`, whose `own` scope means "holds a seat on this task", not claim eligibility (problems D7).

**Done when** a non-admin sees names, not UUIDs; a restricted division's tasks are invisible to non-members; the D2 and D20 lockout scenarios are refused in E2E tests; a fresh install's first admin can create a task and an invited member can claim and submit.

### Phase 3: Lifecycle, events & audit

**Summary.** Cut undo down to where it's needed, and replace the three parallel audit trails with one typed event stream.

**Work items**
1. **Undo scope.** Retire → grace → revive → GC stays for Task, User, Division, Team, Role and IntegrationConnection. Grant, Message and Attachment become hard delete plus an audit row; a deleted message leaves a "deleted" marker in the thread. Remove about 12 revive endpoints, actions and resolvers (intent-vs-reality §6.4, register B2, problems D16).
2. **Event outbox.** Aggregates raise typed domain events. The unit of work writes them to one `domain_event` table in the same transaction. Three projections read from it (see [§5.3](#53-the-typed-event-model)):
   - **Audit:** the `activity` row, with the §6.5 content rules
   - **Task timeline:** typed timeline entries the client renders from structured data, replacing system messages and the client's regex parsing
   - **Notifications:** created by a worker consumer, idempotent on `(event_id, recipient)`, replacing `event_seq`

   (problems R7, D11, register F9.)
3. **Audit content.** Before → after values for configuration and state; IDs only for personal data and user-authored text. The submission-retire reason lives only in the timeline entry (intent-vs-reality §6.5, problems D18).
4. **System messages are gone.** Timeline entries aren't messages, so `message:update` can't edit them (problems D27).
5. **Notifications.** Emit every declared notification type or delete it, including `retired_block` and the eviction notice (problems D18, D17). Fix pagination: the cursor carries `(read_at IS NULL, id)` to match the sort order (problems D19).
6. **Retired tasks stay readable.** During grace, a retired task's thread and timeline can be read by anyone holding `task:read` on it (problems D15).
7. **GC and scrub.** Purge `external_identity` on scrub and before collecting a user. Add foreign keys for `grant` scope columns and invitation role IDs (a join table replaces `intended_role_ids`) (problems D10, D27).

**Done when** the web client renders the task history without a regex; retrying a notification job creates no duplicate; a Discord-linked user with no history is collected, and a history-bearing one is scrubbed of their Discord ID and handle.

### Phase 4: Work model & templates

**Summary.** Implement the request template library (§3), make the claim lifecycle match the settled slot rules, store completion as a fact, and make attachments safe.

**Work items**
1. **Request template library and custom templates.** Everything in [§3](#3-new-requirement-request-template-library-and-custom-templates).
2. **Slot rules** (intent-vs-reality §6.1, problems D28):
   - `leave` refuses once the claimant has a live submission.
   - Retiring a submission removes its claimant and opens the seat for anyone.
   - Rejection keeps the claimant in the seat, unable to resubmit.
   - Eviction is always allowed; the evictee's submission stays as a record, is treated as rejected and leaves the roll-up; the evicted user is notified and the timeline records an eviction (problems D17).
3. **Completion is a fact.** `task.completed_at` and `completed_by`. Completing closes claims and marks outstanding submissions "no longer required". Status is derived from facts plus slots by one pure function, used on every path including creation. `status_cache` becomes a non-null column that a check can rebuild from facts (problems R4, D5; see [§5.2](#52-the-completion-fact)).
4. **Attachments.** Uploads are owned by their uploader in a `pending` state. Submit claims only the submitter's own pending uploads for that task; messages likewise. The XOR ownership (message or answer) is kept. Uploads stream to storage with an incremental hash (problems D1, register F3, F6).
5. **Attachment answers.** A dedicated upload-for-answer endpoint so attachment questions can be answered. The pure validator ships as a shared package used by the API and the web client (problems D25, intent-vs-reality §2.1).
6. **Openings.** `defaultOpenings` and `openings` must be at least 1; `openings_locked` locks increases only (problems D27, register E8).

**Done when** the D1, D5 and D28 failure scenarios are E2E tests that pass; a task with a required attachment question can be submitted; §3.8 holds.

### Phase 5: Processes & background work

**Summary.** Make the API and worker split structural, and make background work fail loudly instead of silently.

**Work items**
1. **Explicit composition.** Two root modules, `ApiModule` and `WorkerModule`, each importing only what it runs. Email, GC, sync and the Gateway exist only in the worker. Remove the per-module `PROCESS_ROLE` checks. Keep the combined mode for development by importing both. A test asserts the API opens no socket, schedules no cron and consumes no queue (ADR 0003's promise, problems R2).
2. **Queue health.** A failed enqueue returns an error to the caller instead of being logged and dropped. `/health` reports degraded when pg-boss isn't running (problems R8, register A7).
3. **Retries.** Handlers throw on failure so pg-boss retries them, with per-queue retry limits and a dead-letter queue the admin UI can show.
4. **API → worker signals.** Connection create, token rotate, retire and revive enqueue a `gateway.reconcile-sessions` job, so the worker opens, restarts or closes Gateway sessions without a restart (problems D21).
5. **Schedules.** Register every scheduled job that has a consumer (the reconcile floor, GC), or delete the consumer (problems R8).
6. **Tests on the real queue.** E2E tests run with pg-boss on, in synchronous mode, as the old docs intended.

**Done when** stopping pg-boss makes `/health` report degraded and makes email-sending requests fail visibly; a new Discord connection gets a Gateway session without a worker restart.

### Phase 6: Discord integration

**Summary.** Keep the full scope (decision 4) and fix its execution: implement ADR 0002 as written, create sync links automatically and hold the bot-token key in the worker only.

**Work items**
1. **Provider-shaped port.** `SyncService` depends on `IntegrationSyncPort`, not on `DiscordAdapter`. Discord specifics (guild IDs, avatar hashes, the Gateway) stay inside the adapter (problems R11).
2. **Membership sync.** Mappings can target a **membership** as well as a role, now that Phase 2 has separated them.
3. **Transactional sync with a correct baseline.** Each user's sync applies its Patrice-side writes and baseline updates in one transaction, and the baseline is written **after** outbound pushes succeed. Cold-baseline conflicts break ties by Discord audit-log time when it's available, then by `conflict_winner`. `sync_state` is reset on any failure (problems D9, D26, register G2, G3).
4. **Reconcile floor.** One fixed floor, measured on `last_sync_at`; the admin UI reads the same value from the API instead of keeping its own copy of the constants (problems D8, D27, register G6).
5. **Automatic sync links.** Create a sync link wherever Patrice knows the member's Discord ID: at Discord registration, on "Connect Discord", and for every existing member when a connection is added (intent-vs-reality §6.2, problems D22).
6. **Mapping delete and connection retire.** The admin sees how many roles or memberships the mapping granted and chooses "keep as native" (the default) or "revoke". Connection retire pauses sync and records the choice, which is applied when the connection is collected; revive cancels it. Revocations go through the unit of work, so the admin floor applies. The audit verb is `deleted`, not `retired` (intent-vs-reality §6.3, problems D23).
7. **Governance carve-out at grant time.** Refuse granting a governance action to a role that is mapped inbound, as well as mapping a role that holds one. Inbound revokes run under the admin floor (problems D4).
8. **Key custody.** One mandatory AEAD key, provisioned to the worker only. The API never encrypts bot tokens itself: it hands the plaintext to the worker over a dedicated queue job that isn't retained, or encrypts with the worker's public key. Remove the plaintext fallback, the dev default key, and admin-supplied `credentialsRef`. Drop the decrypt-only Vault and KMS adapters until a deployment needs them (problems D13, D27, register G7, G10).
9. **Reconnecting a retired guild** revives the retired connection instead of failing on the unique index (problems D27).
10. **Remove dead code:** `IntegrationStatus.disabled`, the unscheduled consumer, the mismatched Vault handle format (problems D27).

**Done when** the D9 scenario (push, revoke while the Gateway is down, resync) leaves the revoke in place; a member who registered through Discord has mapped roles synced without clicking anything; the API container has no bot-token key in its environment.

### Phase 7: Web client

**Summary.** Adopt the new contract in the web app, then merge it with the UI branch.

**Work items**
1. Use the generated client everywhere; split `api.service.ts` into per-area services returning Observables (problems Part 3).
2. Drive every control from `allowedActions`, not from "is admin".
3. Render the task timeline from typed events; delete the regex parser in [task-presentation.ts](../web/src/app/pages/tasks/task-presentation.ts).
4. Show names from the new read endpoints; remove the UUID fallback in `lookup.store.ts`.
5. The template picker and "Write my own" flow (§3.7), the attachment-answer upload, the account page (Phase 1), the session list, and the mapping-delete choice.
6. Remove the `color` fields the API never had (problems D18).
7. **Merge the UI branch.** Rebase it onto the contract changes and resolve conflicts. The UI branch's design decisions win on layout and look; this plan's contract wins on data and behaviour.

**Done when** the web client has no hand-written API types, no admin-only shortcuts and no regex event parsing, and the UI branch is merged.

### Phase 8: Cutover & documentation

**Work items**
1. Run every migration against a copy of production data (or re-seed, if there is none) and compare entity counts, access decisions for a sample of users, and task statuses before and after.
2. Write the new architecture document and ADRs for the decisions in §5 and in intent-vs-reality. Update `UBIQUITOUS_LANGUAGE.md` (Membership, Template Library, Custom Template, Timeline Entry; remove Inherent Role).
3. Clean up comments that describe delivery history ("Slice 4", test filenames like `slice4-claiming.e2e-spec.ts`) or point into `docs/old/` (problems Part 3, D18).
4. Mark the four review documents as historical, with a pointer to the new architecture document.

---

## 5. Decisions this plan proposes

The reviews left these open. The plan assumes the answers below; each should be confirmed before its phase starts.

### 5.1 Division → team hierarchy

*Needed before Phase 2.* **Proposed:** every team belongs to exactly one division. A task's team must be in the task's division. Division membership is **not** implied by team membership; both are explicit rows, so scopes stay predictable. Cedar parents run team → division, so a division-scoped grant covers that division's teams' tasks. *Alternative:* keep teams independent of divisions, as today, and accept that scopes can't be inherited.

### 5.2 The completion fact

*Needed before Phase 4.* **Proposed:** completion is terminal; there's no reopen. A completed task closes claims, keeps its submissions as records, and shows "approved". If reopening turns out to be needed, it's a separate `task:reopen` action that clears `completed_at` and raises an event.

### 5.3 The typed event model

*Needed before Phase 3.* **Proposed:** one `domain_event` table (id, type, aggregate type and ID, actor, typed payload, occurred_at), written in the business transaction, with event types defined once in Zod and exported in the contract. Audit, timeline and notifications are projections of it. Audit and timeline rows are written synchronously in the same transaction; notifications are created asynchronously by a worker consumer.

### 5.4 Template library deletion

*Needed before Phase 4.* **Proposed:** hard delete with an audit row (§3.2), because tasks keep snapshots. *Alternative:* an `archived` flag that hides a template from the picker but keeps it for later reuse. Worth adding only if admins ask to hide templates temporarily.

---

## 6. Traceability

Every root cause and defect from [current-design-problems.md](current-design-problems.md), grouped by the phase that removes it. Nothing on that list is left unassigned.

| Phase | Root causes | Defects |
|---|---|---|
| 0 Foundations | R3 (continued in every phase), R9, R10 | D27 (FK errors as 500s) |
| 1 Identity & accounts | R10 (secrets) | D3, D12, D18 (token race, bootstrap hash, session slide), D24, D27 (invite expiry) |
| 2 Membership & authorization | R1, R5, R6 | D2, D4 (floor part), D7, D14, D20, D27 (roles granted to retired users), D29 |
| 3 Lifecycle, events & audit | R7 | D10, D11, D15, D16, D17 (notice), D18 (audit free text, unsent notification types), D19, D27 (FK-less IDs, editable system messages) |
| 4 Work model & templates | R4 | D1, D5, D6, D17 (eviction record), D25 (API), D27 (zero openings), D28 |
| 5 Processes & background work | R2, R8 | D18 (bootstrap rotation per replica), D21 |
| 6 Discord integration | R11 | D4, D8, D9, D13, D22, D23, D26, D27 (retired guild, `credentialsRef`, dead integration code) |
| 7 Web client | – | D18 (`color` fields), D25 (UI) |
| 8 Cutover & documentation | – | D18 (stale comments) |
