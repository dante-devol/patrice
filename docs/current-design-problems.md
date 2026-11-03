# Patrice: Structural Problems in the Existing Design

> **Companion to [current-architecture.md](current-architecture.md).** That document describes what exists. This one lists what is wrong with it: structural failings, defects found while mapping the code, and the root causes behind them. A third document, [current-design-decisions.md](current-design-decisions.md), grades every design decision by whether it has a strong use case. Like the other two, this one was written only from the source code, with no reference to the old design documents. It was updated after a second, API-focused sweep (D19–D27). [intent-vs-reality.md](intent-vs-reality.md) compares all of this against the old design docs and records the owner's direction decisions; where it marks something as intended, that takes precedence over the framing here.
>
> Snapshot: `main` at `c322ae2` (November 2026). Every item here is assigned to a phase in [redesign-plan.md](redesign-plan.md) §6.

---

## How to read this

The document has three parts:

1. **[Root causes](#part-1-structural-root-causes).** About a dozen design-level failings. Most of the specific bugs in Part 2 come from one of these. Read this part if you're planning the redesign.
2. **[Concrete defects](#part-2-concrete-defects).** Specific behaviours that are wrong today, each linked to a root cause. Read this part if you're deciding what to carry over or what to test for in the new design.
3. **[Maintainability smells](#part-3-maintainability-smells).** Things that make the code harder to change, but that aren't wrong in themselves.

**Severity**

| | Meaning |
|---|---|
| 🔴 **High** | Security exposure, data loss or corruption, or a guarantee the system claims but doesn't keep |
| 🟠 **Medium** | Wrong behaviour users or operators will hit, or a design limit that blocks plausible requirements |
| 🟡 **Low** | Friction, dead code, inconsistency |

**Confidence**
- **Verified**: traced through the code path by reading it.
- **Likely**: follows from the code by reasoning, but wasn't run.

Nothing here was confirmed by running the system.

---

## Summary

Items whose direction was settled with the owner (in [intent-vs-reality.md](intent-vs-reality.md) §1 and §6) carry a **Direction (decided)** note in their section.

| ID | Problem | Sev. | Kind |
|----|---------|------|------|
| [R1](#r1-authorization-only-covers-writes) | Authorization only covers writes; all reads are open | 🔴 | Root cause |
| [R2](#r2-the-process-split-is-nominal) | The api/worker process split is nominal; important state lives in one process's memory | 🔴 | Root cause |
| [R3](#r3-business-rules-are-transaction-scripts-with-hand-copied-invariants) | Business rules are transaction scripts with hand-copied invariants | 🔴 | Root cause |
| [R4](#r4-a-cache-that-is-also-state-status_cache) | `status_cache` is a cache that is also used as state | 🟠 | Root cause |
| [R5](#r5-membership-is-a-role) | Membership and authority are the same thing (inherent roles) | 🟠 | Root cause |
| [R6](#r6-resource-resolvers-are-a-second-domain-layer) | Resource resolvers are a second, parallel domain layer | 🟠 | Root cause |
| [R7](#r7-system-messages-are-a-stringly-typed-protocol) | System messages are a stringly-typed protocol parsed by regex | 🟠 | Root cause |
| [R8](#r8-background-work-is-best-effort-by-construction) | Background work is best-effort by construction | 🟠 | Root cause |
| [R9](#r9-a-singleton-tenant-dressed-as-multi-tenant) | A singleton tenant dressed up as multi-tenant | 🟠 | Root cause |
| [R10](#r10-configuration-and-secrets-share-untyped-blobs-and-overloaded-keys) | Configuration and secrets share untyped blobs and overloaded keys | 🟠 | Root cause |
| [R11](#r11-the-integration-is-discord-shaped-not-provider-shaped) | The integration is Discord-shaped, not provider-shaped | 🟡 | Root cause |
| [D1](#d1-submitting-can-steal-any-attachment-in-the-org) | Submitting can move any attachment in the org onto your answer | 🔴 | Defect |
| [D2](#d2-retiring-a-division-or-team-can-remove-the-last-admin) | Retiring a division or team can remove the last admin | 🔴 | Defect |
| [D3](#d3-discord-login-is-open-to-login-csrf) | Discord login is open to login CSRF | 🔴 | Defect |
| [D4](#d4-governance-carve-out-can-be-bypassed-after-mapping) | Governance carve-out can be bypassed after a role is mapped | 🔴 | Defect |
| [D5](#d5-manual-complete-is-silently-undone) | Manual complete is silently undone | 🟠 | Defect |
| [D6](#d6-editing-a-task-template-crashes-once-a-submission-has-been-retired) | Editing a task template crashes once a submission has been retired | 🟠 | Defect |
| [D7](#d7-a-claimant-can-become-unable-to-leave) | A claimant can become unable to leave | 🟠 | Defect |
| [D8](#d8-reconcile-floor-measures-the-wrong-clock) | The reconcile floor measures the wrong clock | 🟠 | Defect |
| [D9](#d9-bidirectional-baseline-records-the-pre-sync-state) | Bidirectional baseline records the pre-sync state | 🟠 | Defect |
| [D10](#d10-gc-cannot-collect-discord-linked-users-and-scrub-leaves-their-handle) | GC can't collect Discord-linked users, and scrub leaves their handle | 🟠 | Defect |
| [D11](#d11-notification-idempotency-is-illusory) | Notification idempotency is illusory | 🟠 | Defect |
| [D12](#d12-bearer-tokens-sit-in-plaintext-in-the-job-table) | Bearer tokens sit in plaintext in the job table | 🟠 | Defect |
| [D13](#d13-bot-token-custody-split-does-not-hold) | Bot-token custody split doesn't hold | 🟠 | Defect |
| [D14](#d14-requirediscordlink-is-enforced-only-by-the-browser) | `requireDiscordLink` is enforced only by the browser | 🟠 | Defect |
| [D15](#d15-retired-task-history-is-unreachable) | A retired task's thread can't be read | 🟡 | Defect |
| [D16](#d16-standalone-roles-that-ever-had-a-grant-are-never-collected) | Standalone roles that ever had a grant are never collected | 🟡 | Defect |
| [D17](#d17-eviction-notifies-the-wrong-person-and-records-the-wrong-event) | Eviction notifies the wrong person and records the wrong event | 🟡 | Defect |
| [D18](#d18-smaller-defects) | Smaller defects (token races, dead config, PII in audit, …) | 🟡 | Defect |
| [D19](#d19-notification-pagination-is-broken) | Notification pagination is broken | 🟠 | Defect |
| [D20](#d20-a-forbid-grant-can-lock-out-every-admin) | A forbid grant can lock out every admin | 🔴 | Defect |
| [D21](#d21-gateway-sessions-only-change-on-worker-restart) | Gateway sessions only change on worker restart | 🟠 | Defect |
| [D22](#d22-discord-registration-and-new-connections-do-not-create-sync-links) | Discord registration and new connections don't create sync links | 🟠 | Defect |
| [D23](#d23-deleting-a-mapping-strands-the-roles-it-granted) | Deleting a mapping strands the roles it granted | 🟠 | Defect |
| [D24](#d24-users-cannot-manage-their-own-account) | Users can't manage their own account | 🟠 | Defect |
| [D25](#d25-attachment-questions-cannot-be-answered) | Attachment questions can't be answered | 🟠 | Defect |
| [D26](#d26-integration-sync-is-non-transactional-and-can-wedge) | Integration sync is non-transactional and can get stuck | 🟡 | Defect |
| [D27](#d27-second-sweep-smaller-findings) | Second-sweep smaller findings | 🟡 | Defect |
| [D28](#d28-the-claim-lifecycle-contradicts-the-settled-slot-rules) | The claim lifecycle contradicts the settled slot rules | 🟠 | Defect |
| [D29](#d29-a-fresh-install-cant-do-any-work) | A fresh install can't do any work | 🟠 | Defect |

---

## Part 1: Structural root causes

### R1. Authorization only covers writes

🔴 · Verified

**What.** Cedar gates only routes marked `@Authorize`, and every one of those is a mutation. Task list and detail, submissions, messages, request-template reads and **attachment downloads** check only that the caller is logged in ([tasks.controller.ts:79](../api/src/tasks/tasks.controller.ts:79), [submissions.service.ts:301](../api/src/submissions/submissions.service.ts:301), [attachments.controller.ts](../api/src/attachments/attachments.controller.ts)). Admin *list* endpoints are gated by borrowing an unrelated mutation (`GET /users` needs `user:update`, `GET /roles` needs `role:create`).

**Why it matters.**
- **Restricted claims don't mean restricted visibility.** A division that limits claims to its members still exposes every task, submission and uploaded file to every user in the org.
- **Non-admins can't see names.** Because names are only available from admin-gated lists, the web client shows non-admins **truncated UUIDs** instead of user, division and team names ([lookup.store.ts](../web/src/app/core/lookup.store.ts)). The UX defect follows directly from the authorization gap.
- **The client knows very little about rights.** It gets only two booleans (`inviteCreate`, `manageOrg`). Task controls appear according to "is admin", not according to what the user can actually do on that task ([task-detail.component.ts:349](../web/src/app/pages/tasks/task-detail.component.ts:349)).

**Direction (decided 2026-11-02).** Design visibility in now: read actions join the vocabulary, and Cedar decides visibility, restricted divisions included. Per-entity allowed actions replace the two capability booleans ([intent-vs-reality §1](intent-vs-reality.md#1-direction-decided-2026-11-02), Decision 3).

**Root cause.** The action vocabulary was designed as a list of *verbs that change things*. Visibility was never modelled as a permission, so the read side has no part in the authorization design.

---

### R2. The process split is nominal

🔴 · Verified

**What.** `PROCESS_ROLE` is meant to separate HTTP from background work, but each module decides for itself whether to respect it, and several don't:

| Component | Respects role? | Consequence |
|---|---|---|
| `SyncService`, `IntegrationGatewayService` | yes | – |
| `BootstrapService` | yes (API only) | each API replica mints and rotates its *own* bootstrap key and token |
| `EmailService` consumer | **no** ([email.service.ts:31](../api/src/email/email.service.ts:31)) | the API process also runs email jobs |
| `GcModule` consumer and schedule | **no** ([gc.module.ts:28](../api/src/gc/gc.module.ts:28)) | the API process also runs GC sweeps. *(ADR 0003 calls queue-consumer gating "hygiene, not correctness", since pg-boss runs each job once; but the ADR also promised a test asserting the API schedules no cron.)* |
| `InProcessPubSub` | n/a, in memory | worker-written notifications never ping; a second API replica's users miss pings |
| `ThrottlerModule` | n/a, in memory | rate limits are per replica |
| Gateway health map | n/a, in memory | only correct because sync and Gateway happen to share a process |

**Why it matters.** The deployment *looks* ready to scale out: there's a separate worker, a separate migrate step, and comments that say "scale-ready". It isn't. Running two API replicas breaks live notifications and bootstrap, and leaves rate limiting toothless. The "API never holds the key" custody claim doesn't hold either ([D13](#d13-bot-token-custody-split-does-not-hold)).

**Direction (decided 2026-11-02).** The redesign targets one API plus one worker, so fix the role checks but don't build multi-replica support.

**Root cause.** The process role is an ambient flag that each module checks (or forgets to check) for itself. Nothing structural states which components belong to which process, and nothing stops state being kept in process memory.

---

### R3. Business rules are transaction scripts with hand-copied invariants

🔴 · Verified

**What.** Each service method is a hand-written sequence of steps:
1. load
2. check
3. open `$transaction`
4. write
5. log activity
6. maybe bump `config_version`
7. maybe notify
8. maybe write a system message
9. maybe recompute status

Invariants that *should* hold everywhere are instead re-implemented, or left out, at each call site:

- **The admin floor** is applied on user deactivate, retire and revoke-role, on role retire, and on grant update and retire. It is **missing** on division and team retire ([D2](#d2-retiring-a-division-or-team-can-remove-the-last-admin)), integration-driven revokes ([discord.adapter.ts:442](../api/src/integrations/sync/discord.adapter.ts:442)), Discord unlink, and grant *creation*. It also ignores `forbid` grants entirely ([D20](#d20-a-forbid-grant-can-lock-out-every-admin)).
- **Config-version bumps** are done three ways:
  - `access.bumpConfigVersion(tx)`
  - a raw `organization.update({configVersion: {increment: 1}})` ([invitations.service.ts:409](../api/src/invitations/invitations.service.ts:409))
  - not at all (integration grants)

  Membership changes bump it even though membership isn't part of the cached policy text. They cause needless re-projection without making anything more correct.
- **Activity rows.** Some are written inside the business transaction and some after it (`role.created`, `user.updated`, `invite.created`). A crash between the two leaves an unaudited change.
- **Retirement cascades** are written by hand in each service, and each one covers a different set of effects (§5.1 of the architecture document). Task retirement doesn't release claims. Division retirement doesn't affect its tasks.
- **"Is the parent retired?" is checked inconsistently.** Tasks in a retired division stay fully operable, because the division's retired flag never reaches the task resource. *(The old docs intended this: existing references may "complete their lifecycle". What is missing is the documented block on **new** references, such as granting a retired role or granting roles to a retired user.)*

**Why it matters.** Every new feature has to remember around eight cross-cutting obligations. The existing bugs show that they aren't remembered reliably.

**Direction (decided 2026-11-02).** Build the ports-and-adapters domain layer the old docs called for, with aggregates owning their invariants (Decision 1).

**Root cause.** The project has no domain layer and no unit-of-work abstraction. Prisma is called directly from services, and invariants live in developers' heads and in code comments.

---

### R4. A cache that is also state: `status_cache`

🟠 · Verified

**What.** `task.status_cache` is meant to be a derived roll-up, recomputed from slot and submission state by a pure min-rule. But:
- **Manual complete** writes `approved` straight into the cache without recording any fact about it ([tasks.service.ts:621](../api/src/tasks/tasks.service.ts:621)). The next recompute discards it ([D5](#d5-manual-complete-is-silently-undone)).
- **Task creation** uses a different, older function (`computeStatusCache`) from every other path (`computeMinRuleStatus`).
- **The cache is nullable** ("until first computed"), and the client fills in the gap (`stampStatus(null) → 'open'`).

**Why it matters.** The task list filters and sorts on a value that can be wrong, and nothing exists to rebuild it.

**Root cause.** "Completed" isn't modelled as a fact about the task, so the only place to put it was the cache.

---

### R5. Membership is a role

🟠 · Verified

**What.** Belonging to a division or team is represented *only* as holding its auto-created inherent role ([access.service.ts](../api/src/access/access.service.ts), `buildPrincipalEntities`). The consequences:
- You can't be a member of a division without also receiving every grant attached to its inherent role, and the reverse is also true.
- **Discord sync can only map roles.** Mapping a Discord role to "member of division X" means mapping the inherent role, which brings that role's grants with it.
- **Teams aren't related to divisions.** A task names a division and, optionally, *any* team. There's no hierarchy for scopes to inherit through.
- Renaming a division renames its role. Retiring a division retires its role. And because the admin floor isn't applied to division retire, this can remove an admin ([D2](#d2-retiring-a-division-or-team-can-remove-the-last-admin)).

**Direction (decided 2026-11-02).** Membership becomes first-class (`membership(user, unit)`); authority comes only from roles; inherent roles go away (Decision 2). The old docs' unenforced rule that inherent-role grants are pinned to their unit becomes moot.

**Root cause.** The authorization model had a "role" concept and no "membership" concept, so membership was encoded as a role to make the `own_division` / `own_team` scopes work.

---

### R6. Resource resolvers are a second domain layer

🟠 · Verified

**What.** [`authorize.decorator.ts`](../api/src/access/authorize.decorator.ts) holds around 15 resolver functions. Each one runs its own Prisma query to rebuild a Cedar resource from route parameters. The service then loads the same rows again. Specific problems:
- **Revive variants exist only to get around policy.** `taskReviveResource`, `messageReviveResource` and `attachmentReviveResource` exist solely to *leave out* the `retired` attribute so that the static hard-deny doesn't fire. Policy is effectively being expressed by which attributes get built.
- **Resolvers read the raw body.** The guard runs before Zod validation, so `taskCreateResource` reads `divisionId` from an unvalidated body.
- **Resources are fabricated for checks with no real target.** For example `id: 'prospective-invitee'` and `id: 'new'`.
- **Governance can only be global.** Governance actions are bound to the `Organization` resource, so they can never be scoped. That forced a special exception for `division:update`.
- **Every decision repeats the same reads.** It reads `organization.config_version` and the user's roles each time, and a page that triggers several decisions (for example `/me` makes two) repeats them.

**Root cause.** Two things combine here. Authorization is attached to HTTP routes, not to domain operations. And Cedar entities are built per request instead of from one shared entity loader.

---

### R7. System messages are a stringly-typed protocol

🟠 · Verified

**What.** Task events are written into the thread as `message.body` strings in three different formats:
- English sentences with raw UUIDs: `"User <uuid> claimed this task."`
- JSON: the submission-retire audit message
- free text: `"Requester changed to user <uuid>."`

The web client turns them back into events with **regexes** ([task-presentation.ts:176](../web/src/app/pages/tasks/task-presentation.ts:176)). Any wording change silently breaks the history view. The same events are also written to `activity` with typed payloads, so the system keeps two audit trails that can drift apart.

**Root cause.** The thread was used as an event log because no typed event model existed for the client to render.

---

### R8. Background work is best-effort by construction

🟠 · Verified

**What.**
- **The queue fails silently.** [`QueueService`](../api/src/queue/queue.service.ts) turns any pg-boss start failure into "jobs disabled", and turns every publish after that into a logged drop. Verification and reset emails, GC and Discord sync all vanish without any error reaching a user or a health check.
- **Failures aren't retried.** Job handlers catch and log their own errors (`EmailService.deliver`, `SyncService.runSync`), so pg-boss records every job as successful.
- **Dead and stray consumers.** The `integration-sync-scheduled` consumer is registered but never scheduled ([sync.service.ts:68](../api/src/integrations/sync/sync.service.ts:68)). GC and email consumers also run in the API role ([R2](#r2-the-process-split-is-nominal)).
- **Untested.** E2E tests run with `DISABLE_QUEUE=true`, so no consumer path is tested end to end.

**Root cause.** "Never block the request path on queue health" was taken to mean "never surface queue failure at all".

---

### R9. A singleton tenant dressed as multi-tenant

🟠 · Verified

**What.** Every table carries `organization_id`, but the `organization.singleton` unique column allows only one row, and the code reads the org with an unfiltered `findFirst()` in about a dozen places (sessions, access, bootstrap, GC, Discord OAuth). Login finds users by email across the whole table. Some services filter by `organizationId` and others look up by `id` alone.

**Why it matters.** The columns suggest multi-tenancy is close, but the queries would all need auditing first. In the meantime the columns add indexes, join conditions and an inconsistency that suggests a protection which isn't there.

**Direction (decided 2026-11-02).** Single-org; drop the `organization_id` seam (Decision 6).

**Root cause.** The design hedged on the future: it added the columns now but deferred their meaning.

---

### R10. Configuration and secrets share untyped blobs and overloaded keys

🟠 · Verified

**What.**
- **Settings JSON.** `organization.settings` is a JSON blob that mixes policy toggles, session lifetimes and an **encrypted OAuth client secret**. Its shape is enforced only by a TypeScript spread over defaults ([config.service.ts](../api/src/users/config.service.ts)).
- **`SESSION_SECRET` does four jobs.** It signs cookies, signs the OAuth `state`, and acts as the HKDF root for the Discord OAuth secret. Rotating it silently breaks Discord login until an admin re-enters the secret.
- **Untyped config elsewhere too.** `integration_connection.config` can still hold a **plaintext bot token** as a fallback ([integrations.service.ts:75](../api/src/integrations/integrations.service.ts:75)). `question.constraints` and `answer.value` are also untyped JSON.
- **Dead and stray env vars.** `RETIREMENT_GRACE_DAYS` is validated but never read; the real window is `settings.gracePeriodHours`. `DISABLE_QUEUE` is read from raw `process.env`, outside the schema.

**Root cause.** It was never decided what is a setting, what is a secret and what is schema. All three were stored wherever was most convenient.

---

### R11. The integration is Discord-shaped, not provider-shaped

🟡 · Verified

**What.** `IntegrationSyncPort` and `SecretCipherPort` look generic, but everything around them is Discord-specific:
- `DiscordAdapter`, the Gateway websocket, guild snowflakes and avatar hashes
- the OAuth app shared with *sign-in*
- `SyncService` injecting `DiscordAdapter` directly instead of using the port
- `ConflictWinner` / `sync_baseline` semantics built around Discord role edges

Also, the "custody" adapters for Vault and KMS can only decrypt, so they can't actually be selected for new tokens.

**Root cause.** The interfaces were drawn after a single implementation existed, and that implementation was never moved behind them.

---

## Part 2: Concrete defects

### D1. Submitting can steal any attachment in the org

🔴 · Verified · from R3/R6

**What.** At submit time, attachments referenced in `answers[].attachmentIds` are re-owned with:

```ts
tx.attachment.updateMany({ where: { id: { in: ids }, organizationId }, data: { answerId, messageId: null } })
```

([submissions.service.ts:236](../api/src/submissions/submissions.service.ts:236)). The query doesn't check the uploader or the task. The validator checks only that the attachment exists, is active and has the right type.

**Failure scenario.** Any claimant submits with the ID of a file someone else posted on any other task's thread. That file **disappears from its original message** and becomes part of the attacker's submission. Download is ungated, so attachment IDs are easy to collect from any thread.

---

### D2. Retiring a division or team can remove the last admin

🔴 · Verified · from R3/R5

**What.** Division and team retire cascade-retire the inherent role and bump `config_version`, but don't run inside `withAdminFloor` ([divisions.service.ts:173](../api/src/divisions/divisions.service.ts:173), [teams.service.ts:155](../api/src/teams/teams.service.ts:155)). The role-retire path refuses this case, but the division path doesn't.

**Failure scenario.** An admin attaches the governance grants to a division's inherent role (the matrix allows it), then retires the division. The effective-admin count drops to zero and the org can't be administered. Bootstrap only reopens on the next API restart.

---

### D3. Discord login is open to login CSRF

🔴 · Likely · from R10

**What.** The OAuth `state` is stateless: it's HMAC-signed with a nonce, but **not bound to the browser** by any cookie ([oauth-state.ts](../api/src/auth/oauth-state.ts), [discord-auth.controller.ts:114](../api/src/discord-auth/discord-auth.controller.ts:114)). The nonce is never stored or checked.

**Failure scenario.** An attacker starts a `login` flow with their own Discord account, captures the callback URL (a valid `code` and `state`), and gets a victim to open it within 10 minutes. The victim is now signed in as the attacker, and anything they do is recorded in the attacker's account. The `register` intent also puts the bearer **invite token** in the readable (base64 JSON) `state` that travels through Discord.

---

### D4. Governance carve-out can be bypassed after mapping

🔴 · Verified · from R3

**What.** `assertNotGovernanceRole` refuses to map a role that *currently* holds a global governance grant, but it runs only at mapping-creation time ([integrations.service.ts](../api/src/integrations/integrations.service.ts), around line 385). `GrantsService.create` / `update` never check whether the role is already mapped.

**Failure scenario.** An admin maps role R inbound to a Discord role, then gives R `grant:create` globally. Anyone with Discord "Manage Roles" in that server can now make any linked Discord user a Patrice admin. Inbound revokes don't apply the admin floor either.

---

### D5. Manual complete is silently undone

🟠 · Verified · from R4

**What.** `complete()` writes `status_cache = approved`. Any later claim, leave, evict, manage-claims, submit or review calls `recompute`, which works the status out from slots again. Claims also stay open after completion.

**Failure scenario.** The requester marks a task complete. A late claimant then joins, which is still allowed, and the task goes back to `open`. Nothing in the data records that the task was ever completed.

---

### D6. Editing a task template crashes once a submission has been retired

🟠 · Likely · from R3

**What.** The template lock counts only *active* submissions. Editing then runs `question.deleteMany`. But `answer.question_id` is `ON DELETE RESTRICT`, and answers belonging to **retired** submissions still exist until GC removes the whole task ([request-templates.service.ts:98](../api/src/request-templates/request-templates.service.ts:98)).

**Failure scenario.** A submission is retired, which unlocks the template. The requester edits the template and gets a 500 from a foreign-key violation, not a 409.

---

### D7. A claimant can become unable to leave

🟠 · Verified · from R6

**What.** `POST /tasks/:id/leave` is authorized as `task:assign` ([tasks.controller.ts:119](../api/src/tasks/tasks.controller.ts:119)). Its `own` scope compiles to *claim eligibility* (the restrict-claims rule), not to "you hold a slot".

**Failure scenario.** A user claims a task, then loses their division role, or the division turns on `restrictClaims`. Every leave attempt now returns 403, and only the requester can evict them.

**Direction (decided 2026-11-02).** Leaving is allowed only *before* a first submission (§6.1). Within that window it should depend on holding the seat, not on claim eligibility, so this defect still stands.

---

### D8. Reconcile floor measures the wrong clock

🟠 · Verified

**What.** The floor tick decides whether a connection is stale using `integration_connection.updated_at` ([sync.service.ts:220](../api/src/integrations/sync/sync.service.ts:220)). That column is bumped by every Gateway member event (`gatewayLastEventAt`), every state change and every sync-state write.

**Failure scenario.** On a busy server the row is touched constantly, so the 6-hour full reconcile **never runs**, and per-user doorbell syncs become the only correctness mechanism. `last_sync_at` exists and is the column that should be used.

---

### D9. Bidirectional baseline records the pre-sync state

🟠 · Likely · from R11

**What.** The reconciler builds `baselineUpserts` / `baselineDeletes` from the **pre-apply** external snapshot ([reconciler.ts:139](../api/src/integrations/sync/reconciler.ts:139)). After a successful outbound *add*, the edge is recorded as absent.

**Failure scenario.** A role is granted in Patrice and pushed to Discord, but the baseline says "absent". If a revoke happens in Patrice before another sync of that user corrects the baseline (for example while the Gateway is down), the next run concludes that Discord diverged. It **re-grants the role in Patrice**, with `source = integration`, undoing the admin's revoke. In normal operation the Gateway's echo of the bot's own change usually triggers a corrective sync, which hides the bug.

---

### D10. GC cannot collect Discord-linked users, and scrub leaves their handle

🟠 · Likely · from R3

**What.** `purgeUserSatellites` has a comment promising to purge `external_identity`, but doesn't ([gc.service.ts:380](../api/src/gc/gc.service.ts:380)). `external_identity.user_id` is `ON DELETE RESTRICT`.

**Failure scenario.** A retired user with no history who has a Discord link is blocked on every sweep, forever. A history-bearing linked user is "scrubbed" but keeps their Discord ID and handle, which is PII the scrub exists to remove.

---

### D11. Notification idempotency is illusory

🟠 · Verified

**What.** The unique index `(recipient, type, subject, event_seq)` is described as making retries no-ops. But `event_seq` is computed fresh as `MAX + 1` on every call ([notifications.service.ts:61](../api/src/notifications/notifications.service.ts:61)), so a retry gets a *new* sequence number and inserts duplicates. `skipDuplicates` only absorbs concurrent inserts racing on the same `MAX`, and in that case one of them is silently dropped.

---

### D12. Bearer tokens sit in plaintext in the job table

🟠 · Verified · from R8

**What.** Session, invite and reset tokens are carefully stored only as peppered hashes. But the verification and reset **links, plaintext tokens included**, are put into the pg-boss job payload ([email.service.ts](../api/src/email/email.service.ts)) and stay there for pg-boss's retention period. Anyone with read access to the database can reset any pending account.

---

### D13. Bot-token custody split does not hold

🟠 · Verified · from R2

**What.** The design says the API never holds the key that protects bot tokens. In practice:
- `IntegrationsService.secureBotToken` runs in the API process and calls `cipher.encrypt`, and AES-GCM uses the same key to encrypt and decrypt.
- The production compose gives `api` and `worker` the same `.env`.
- If the key is missing, the token is **stored in plaintext** with only a warning ([integrations.service.ts:75](../api/src/integrations/integrations.service.ts:75)).
- The dev compose ships a default `deadbeef…` key.

---

### D14. `requireDiscordLink` is enforced only by the browser

🟠 · Verified · from R1/R10

**What.** The setting is read only by the SPA ([task-list.component.ts:220](../web/src/app/pages/tasks/task-list.component.ts:220)). The API doesn't check it anywhere. The SPA reads it from `GET /config`, which needs `config:update`, so for exactly the non-admin users it's meant to restrict, the read fails and the check evaluates as off.

**Direction (decided 2026-11-02).** The API enforces the gate on task access; it's satisfied by links to every active Discord connection, which are created automatically; a grantable bypass action handles exemptions ([intent-vs-reality §6.2](intent-vs-reality.md#62-settled-requirediscordlink-requirements-session-2026-11-02)).

---

### D15. Retired task history is unreachable

🟡 · Verified

**What.** `MessagesService.listForTask` calls `loadActiveTask`, which throws 409 for a retired task. During the grace period nobody, admins included, can read a retired task's thread to decide whether to revive it.

---

### D16. Standalone roles that ever had a grant are never collected

🟡 · Verified

**What.** `roleUnreferenced` counts *all* grants, retired ones included, and nothing ever garbage-collects grants. A retired role that ever had a permission is kept forever and reported as un-collectable on every sweep.

**Direction (decided 2026-11-02).** Grants become hard-delete plus audit row, with no retire/revive (§6.4), so retired grants no longer pin roles. This defect goes away in the redesign.

---

### D17. Eviction notifies the wrong person and records the wrong event

🟡 · Verified

**What.** `removeClaimant` sends `task.claim_left` to the **requester**, who is usually the person evicting, so the notification is suppressed. The evicted user isn't told. The system message says `"User X left this task."`, so the history shows a voluntary leave ([tasks.service.ts:665](../api/src/tasks/tasks.service.ts:665)).

**Direction (decided 2026-11-02).** Eviction is always allowed, and the evicted claimant's submission is treated as rejected (§6.1). The evicted user must be notified, and the history must record an eviction, not a leave.

---

### D18. Smaller defects

🟡 · Verified unless noted

- **Token reuse race (Likely).** Verification and reset tokens are checked for consumption outside the transaction that consumes them, so two concurrent confirms can both succeed.
- **Weaker hashing for the bootstrap passcode.** It's stored as unpeppered `sha256(key)`, unlike every other secret.
- **Each API replica rotates the bootstrap key.** Every API replica that starts while bootstrap is open rotates the shared invitation's passcode and token, so only the last-booted replica's key works ([R2](#r2-the-process-split-is-nominal)).
- **Free text in the audit log.** The submission-retire `reason` is free text placed in an activity payload. A code comment says this is deliberate ("moderation content, not PII"), but nothing stops a reviewer typing a name or email into it, and a user scrub never touches it. It's the one exception to the "IDs only" rule. **Decided:** the reason lives only in the task-thread audit message; the activity row references it by ID (§6.5).
- **Every request writes the session row** to slide the idle window, and also reads org settings. That's a write on every read request.
- **The web client sends fields the API doesn't have.** It sends and reads `color` on roles and divisions; no such column exists.
- **Notification types that are never sent.** `task.revived`, `task.openings_added`, `invitation.redeemed`, `retired_block` and `last_admin_refused` are declared but never emitted. (`last_admin_refused` exists only as an activity verb.)
- **Comments that contradict the code.** For example: "a daily cron walks all connections" (not scheduled); "`notifyRoleChange` is called by UsersService" (it calls `notifyUserRoleChange`); "Slice 4: open|claimed" on an enum with five states.

---

*The defects below were found in a second, API-focused sweep. The [design decision register](current-design-decisions.md) cross-references them.*

### D19. Notification pagination is broken

🟠 · Verified

**What.** `listForUser` sorts by `read_at NULLS FIRST, id DESC` (unread first), but its cursor is `id < after` ([notifications.service.ts](../api/src/notifications/notifications.service.ts)). The cursor assumes pure ID order.

**Failure scenario.** Page 1 ends on an old *unread* notification. Page 2 then keeps only rows older than that one, so every *read* notification newer than it is skipped and never shown. The SPA only fetches page 1 (`limit: 50`), which hides the problem until a user has more than 50.

---

### D20. A forbid grant can lock out every admin

🔴 · Verified (predicate) / Likely (lockout path)

**What.** The effective-admin predicate counts users with a **permit** grant for a governance action and ignores `forbid` grants entirely ([administrability.service.ts](../api/src/access/administrability.service.ts)). In Cedar, a forbid always beats a permit. `GrantsService.create` doesn't run under the admin floor at all.

**Failure scenario.** An admin creates `forbid grant:create @ global` (and the same for `grant:retire` / `grant:update`) on a role every admin holds. Cedar now denies every admin the actions needed to undo it. The floor still counts more than zero admins, so it never triggers and bootstrap never reopens. The only recovery is editing the database by hand. Also see design register C5 and C12.

---

### D21. Gateway sessions only change on worker restart

🟠 · Verified

**What.** `IntegrationGatewayService.openSession` exists but **has no callers**. Sessions are opened once, in `openAllSessions()`, when the worker boots. Connection create, token rotate and retire all happen in the API process, which can't signal the worker.

**Failure scenario.**
- A newly created connection gets no Gateway (and no doorbell) until the worker restarts.
- A rotated token leaves the old socket running on the old token until it fails.
- A **retired** connection's socket keeps running and keeps enqueueing syncs, which then skip the connection because it is retired.

The admin UI shows `gateway_state` for these connections as whatever the worker last wrote.

---

### D22. Discord registration and new connections do not create sync links

🟠 · Verified

**What.** Discord sign-in (`user_identity`) and the sync link (`external_identity`) are separate rows. The two flows that create them don't match:

| Flow | Creates sign-in identity | Creates sync link |
|---|---|---|
| Register via Discord invite | ✅ | ❌ |
| "Connect Discord" from Account | ✅ | ✅ for each connection that exists *at that moment* |
| Admin creates a new connection | – | ❌ for everyone |

**Failure scenario.** A member who joined *through* Discord has no mapped roles synced until they find and click "Connect Discord", even though they already signed in with it. When an admin adds a second server, nobody is linked to it until each person re-links.

**Direction (decided 2026-11-02).** Patrice creates sync links automatically wherever it already knows a member's Discord ID, including for newly added connections (§6.2).

---

### D23. Deleting a mapping strands the roles it granted

🟠 · Verified

**What.** `deleteMapping` hard-deletes the mapping (the baseline cascades) but leaves every `user_role` row with `source = integration` that it created. No later sync revokes them, because sync only considers roles that are still mapped. Unlink handles this case by hand; mapping deletion doesn't. The audit verb is also wrong: a hard delete is logged as `external_group_mapping.retired`.

**Failure scenario.** An admin removes the mapping from Discord's "Moderator" role to Patrice's "Reviewer" role. Everyone who got Reviewer through Discord keeps it permanently, and those rows are labelled as integration-sourced, so nothing in the admin UI suggests they need native cleanup.

**Direction (decided 2026-11-02).** On mapping delete the admin chooses, after seeing the count: keep the roles as native (the default) or revoke them. Connection retire pauses sync, and the same choice is applied when the connection is collected (§6.3).

---

### D24. Users cannot manage their own account

🟠 · Verified

**What.** The API has no endpoint to:
- change your password while signed in (only the reset-by-email flow exists)
- change your email address
- add a password to a Discord-only account

`DiscordLinkService.unlink` refuses with "Add another sign-in method before disconnecting Discord", but no API exists to add one.

**Failure scenario.** A user who registered with Discord can never leave Discord as a sign-in method. A user whose email address changes is stuck with the old one forever, including for password resets.

---

### D25. Attachment questions cannot be answered

🟠 · Verified

**What.** The API supports `attachment` questions end to end (validator, re-owning on submit, XOR ownership). The web submit dialog **filters them out** ("Attachment answers aren't editable here yet"). No client flow exists to upload a file for an answer: the API only accepts uploads to a *message*, then moves the file at submit.

**Failure scenario.** A division template with a *required* attachment question makes every task created from it impossible to submit from the UI. The validator returns `required_missing`.

---

### D26. Integration sync is non-transactional and can wedge

🟡 · Likely

**What.** `DiscordAdapter.sync` sets `sync_state = running`, then applies every grant, revoke, outbound push and baseline write as separate statements with no transaction. If any statement throws (for example a unique-violation race with an admin granting the same role), `runSync` logs the error and returns.

**Failure scenario.** The connection is left half-applied, with `sync_state = running` indefinitely (the admin UI shows a sync always in progress). The baseline doesn't match the operations that were actually applied, which feeds the bidirectional attribution errors in D9. The job is marked successful, so it isn't retried.

---

### D27. Second-sweep smaller findings

🟡 · Verified unless noted

- **Foreign-key violations become 500s.** `AllExceptionsFilter` turns `P2002` into 409 but lets `P2003` (FK) and `P2025` (record not found) through as 500 `INTERNAL`. D6 and several GC and redemption races surface this way.
- **Reconnecting a retired guild fails.** `connect()` checks for duplicates among *non-retired* connections, but the DB unique index `(org, provider, workspace)` includes retired rows. Reconnecting a guild whose old connection is retired but not yet collected gives a generic 409 `ALREADY_EXISTS`. Revive is the only way back.
- **Admins can supply their own `credentialsRef`.** The connect and update DTOs accept a raw handle (`vault:…`, `kms:…`, `aead:…`). The worker will decrypt whatever ciphertext it is given under the configured keys and send the result to Discord as a bot token, a confused-deputy path to any secret encrypted under those keys. (Likely; low severity, because it needs `integration:update`.)
- **Grants and invites hold IDs without foreign keys.** `grant.scope_division_id`, `scope_team_id`, `scope_role_id` and `invitation.intended_role_ids` are plain UUIDs. After GC deletes a division, any grants scoped to it keep projecting policies for an entity that no longer exists. A pending invite naming a deleted role fails with an FK error (500) at redemption.
- **Roles can be granted to retired users.** `user:grant_role`'s resolver hardcodes `retired: false`, and `UsersService.grantRole` doesn't check the target user's lifecycle.
- **System messages can be edited.** A global `message:update` grant lets the holder edit the senderless *system* messages, which are the thread's audit timeline, and their bodies are parsed by the client (R7). `own` scope can't match them (no sender), but `global` and division scopes can.
- **Dead and mismatched code in the integration.**
  - `IntegrationStatus.disabled` is filtered on, but no code ever sets it.
  - The Vault adapter's documented handle format (`vault:<path>/<ciphertext>`) doesn't match what it implements.
  - The admin UI's next-reconcile time uses `last_sync_at` and its own copy of the floor constants, while the worker uses `updated_at` (D8). The two disagree.
- **Invitation expiry isn't bounded.** `expiresAt` may be in the past (the invite is born expired) or decades ahead.
- **Divisions can default to zero openings.** `defaultOpenings` may be `0`, which creates tasks nobody can claim. The roll-up shows them as `claimed` (empty-set floor), which is misleading.

### D28. The claim lifecycle contradicts the settled slot rules

🟠 · Verified · from R3

**What.** The requirements session settled the slot rules ([intent-vs-reality §6.1](intent-vs-reality.md#61-settled-slot-semantics-decision-8-requirements-session-2026-11-02)). Today's code breaks three of them:

| Settled rule | Today's code |
|---|---|
| No leaving after a first submission | `leave()` never checks `has_submitted`; a submitted claimant can walk away, and their submission silently drops out of the status roll-up |
| Retiring a submission removes the claimant and opens the seat | Only `has_submitted` is cleared; the claimant keeps the seat and can resubmit |
| An evicted claimant's submission is treated as rejected | Eviction removes the claimant from the roll-up but leaves the submission in its old state, so an evicted submission in `review` is never resolved |

**Failure scenario.** A QA tester submits a report, then leaves. The task's status ignores the report, the requester isn't asked to review it, and the seat reopens, which the settled rules forbid.

---

### D29. A fresh install can't do any work

🟠 · Verified

**What.** Bootstrap seeds only an Admin role, and only with governance, config, user, invite and integration actions ([actions.ts](../api/src/access/actions.ts), `ADMIN_SEED_ACTIONS`). No `task:*`, `message:*` or `attachment:*` grants exist anywhere, and no role exists for ordinary members.

**Failure scenario.** A new deployment's first admin can't create a task, and every invited member can't claim, submit or comment, until someone builds roles and matrix cells from nothing.

**Direction (decided 2026-11-02).** Seed Admin with every action at global scope, and seed an editable Member role with own-scoped work grants, pre-assigned on new invitations ([intent-vs-reality §6.6](intent-vs-reality.md#66-settled-seeded-roles-requirements-session-2026-11-02)).

---

## Part 3: Maintainability smells

These aren't bugs, but each one makes change more expensive.

- **Delivery history is baked into the code.** Comments, test filenames (`slice4-claiming.e2e-spec.ts`) and migration names describe *when* something was built, not *what* it is. Comments often point at documents that have now moved to `docs/old/`.
- **The client/server contract is hand-maintained.** [`api.types.ts`](../web/src/app/core/api.types.ts) (423 lines) is kept in step with the API by hand. There's no generated client, no OpenAPI and no shared package.
- **One big client service.** [`api.service.ts`](../web/src/app/core/api.service.ts) (539 lines) wraps every endpoint and returns Promises, so RxJS cancellation is thrown away.
- **Error codes are ad-hoc string literals** scattered across services. There's no catalog for the client to rely on.
- **Question IDs aren't stable.** Templates are replaced wholesale, so analytics, re-use and "same question across tasks" can't be built.
- **Boilerplate on every route.** Each handler manually writes `if (!req.user) throw new UnauthenticatedError()`, and each controller declares its own `AuthedRequest` interface.
- **The version column is mostly decoration.** It's incremented everywhere but checked in one place, so most writes are last-writer-wins.
- **Raw SQL is used for the effective-admin predicate**, and the same query is copied into two methods.
- **Some schema rules live only in migration SQL.** The citext, CHECK and trigger rules aren't visible from `schema.prisma`, so the schema file doesn't tell the whole story.

---

## Where to go from here

The Part 1 root causes raised six questions. Their status after the 2026-11-02 decisions ([intent-vs-reality.md](intent-vs-reality.md)):

| # | Question | Status |
|---|---|---|
| 1 | **Visibility.** Should read access be a first-class permission (R1)? | **Decided:** yes, designed in now. Attaching authorization to domain operations rather than routes (R6) follows from the domain-layer decision. |
| 2 | **Membership.** Should membership be separated from authority (R5)? | **Decided:** yes. A division → team hierarchy is still open. |
| 3 | **Task state.** What are the real facts of a task's lifecycle, as distinct from the roll-up (R4)? | **Partly:** the slot rules are settled (§6.1). A stored "completed" fact for manual complete (D5) is still to design. |
| 4 | **Events.** What single, typed event model feeds the audit log, thread history and notifications (R7, D11)? | **Partly:** audit content is settled (§6.5). The event model itself is still open. |
| 5 | **Processes.** Which components belong to which process (R2, R8)? | **Decided:** one API plus one worker. |
| 6 | **Tenancy.** Is multi-tenancy required (R9)? | **Decided:** no; drop the columns. |
