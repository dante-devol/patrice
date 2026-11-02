# Patrice API: Design Decision Register

> **Third companion** to [current-architecture.md](current-architecture.md) (what exists) and [current-design-problems.md](current-design-problems.md) (what is broken). This register asks a different question about every significant design decision in the API: **what real use case does it serve, and is that use case strong enough to justify what it costs?**
>
> It is based on a full read of `api/` (source, DTOs, migrations, scripts). Code comments were used as evidence of intent. The old design documents were not.
>
> Snapshot: `main` at `c322ae2` (November 2026). **Revised 2026-11-02** after comparing against the old design docs ([intent-vs-reality.md](intent-vs-reality.md)). Rows the comparison changed are marked *(revised)*, and owner direction decisions are marked **Decided:**. A requirements session the same day settled further rows (§6 of that document); D12 and G11 were added for decisions it surfaced.

---

## How to read this

Every decision gets one of five verdicts:

| Verdict | Meaning | What to do in the redesign |
|---|---|---|
| ✅ **Strong** | A clear, present use case, and the implementation fits it | Keep |
| 🟢 **Sound, flawed execution** | The use case is real, but the implementation undermines it | Keep the idea, rebuild the mechanism |
| 🟡 **Over-built** | A real but narrow use case, served by far more machinery than it needs | Simplify, or defer until the need is proven |
| 🟠 **Weak** | A speculative or self-created use case: it exists mainly to work around another decision | Rethink, usually by fixing the decision it works around |
| 🔴 **Unjustified** | No working use case today, or the mechanism doesn't actually deliver what it claims | Remove or replace |

Each row names the **use case** in plain terms: who needs it, and when. Where that is hard to state, the difficulty is the finding.

---

## Verdict summary

There are 84 decisions in total.

| Area | ✅ | 🟢 | 🟡 | 🟠 | 🔴 |
|---|---|---|---|---|---|
| [A. Platform & topology](#a-platform--topology) | 6 | 1 | 0 | 1 | 1 |
| [B. Data model & lifecycle](#b-data-model--lifecycle) | 4 | 4 | 2 | 1 | 2 |
| [C. Authorization](#c-authorization) | 5 | 3 | 1 | 5 | 2 |
| [D. Identity & sessions](#d-identity--sessions) | 6 | 2 | 1 | 2 | 1 |
| [E. Work model](#e-work-model) | 8 | 4 | 1 | 1 | 0 |
| [F. Messages, files, notifications](#f-messages-files-notifications) | 3 | 2 | 0 | 1 | 3 |
| [G. Discord integration](#g-discord-integration) | 3 | 5 | 1 | 1 | 1 |
| **Total** | **35** | **21** | **6** | **12** | **10** |

**Headline.** About 42% of decisions are sound as built. A further 25% are sound ideas whose implementation lets them down. The remaining 33% (28 decisions) either lack a strong use case or don't deliver on the one they claim. Those 28 are the redesign's real agenda, and [the closing section](#decisions-without-a-strong-use-case-ranked) ranks them.

**Three patterns account for most of the weak verdicts:**

1. **Hedges against a future that was never committed to.** The multi-tenant columns, the "scale-ready" process split, `max_uses`, a `version` column on every row, and the Vault/KMS adapters all prepare for something with no current use case. Meanwhile the present-day system pays their cost.
2. **Workarounds that later hardened into features.** The revive resolvers work around the retired hard-deny. Membership is encoded as roles because no membership concept existed. Files are uploaded to a message and then moved onto an answer to satisfy an ownership `CHECK`. System messages carry English strings because the system has no typed event model. Each of these exists only because of an earlier decision.
3. **Mechanisms whose guarantee isn't actually delivered.** Notification idempotency, the bot-token custody split, the admin floor (it ignores forbids, and some paths skip it), and the `requireDiscordLink` setting all claim protection that doesn't exist.

---

## A. Platform & topology

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| A1 | **NestJS modular monolith**, one module per feature | A small team ships one deployable with clear feature seams | ✅ | Right size for the problem. The modules, though, are folders rather than boundaries: services reach into each other's tables freely (see B12). |
| A2 | **Services call Prisma directly**, with no domain or repository layer | Fewer layers, faster delivery | 🟠 | The use case is speed. The cost is that every invariant gets copied by hand into every write path (problems R3). With around 20 aggregates and many cross-cutting rules, this no longer pays. **Decided:** build the ports-and-adapters domain layer the old docs called for, plus an OpenAPI contract emitted from Zod and a generated client. |
| A3 | **PostgreSQL as the only stateful dependency** (data, jobs, locks) | Self-hostable with a single database; nothing extra to operate | ✅ | Strong for a self-hosted product, and it's what makes A6 cheap. |
| A4 | **UUIDv7 primary keys** (Postgres 18 `uuidv7()`), also used as pagination cursors | Time-ordered IDs give index locality and cursor pagination without a separate column | ✅ | Valid, with one exception: notifications sort *unread first*, yet still use `id < after` as the cursor, so their pagination is wrong ([problems D19](current-design-problems.md#d19-notification-pagination-is-broken)). Requires PG18. |
| A5 | **`PROCESS_ROLE` flag**: the same image runs as api, worker or combined | Isolate the Discord Gateway's long-lived sockets and the sync CPU from HTTP latency; scale the API separately | 🟢 | Isolating the worker is a genuine need. Scaling the API is not delivered, because essential state lives in process memory (problems R2). Each module checks the flag for itself, and two modules forget. **Decided:** target 1 API + 1 worker, and drop the scale-out claims. |
| A6 | **pg-boss** for background jobs | Durable queue with no new infrastructure | ✅ | Good fit with A3. |
| A7 | **Queue degrades to a no-op** when it can't start | "Never block login or authorization because the queue is unhealthy" | 🔴 | The goal is real, but the design goes much further than it requires. Failing the *enqueue* call isn't necessary for login to work; what *is* lost is every email and every sync, silently and with no health signal. The degraded state is also reported to nobody. A health flag on `/health` plus fail-loud enqueues for user-visible jobs would meet the goal. |
| A8 | **One global prefix `/api`** behind same-origin nginx | Same-origin cookies, no CORS complexity, a single proxy rule | ✅ | Simple and correct. The `enableCors` call in `main.ts` is redundant in this topology. |
| A9 | **Zod-validated environment, fail fast at boot** | A misconfigured deploy never serves traffic | ✅ | Strong. Undermined slightly by one dead key (`RETIREMENT_GRACE_DAYS`) and one key that skips validation (`DISABLE_QUEUE`). |

## B. Data model & lifecycle

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| B1 | **Singleton organization** with an `organization_id` column on every table | "Multi-tenancy later" | 🔴 | There is no current use case. The columns are never filtered on consistently (problems R9), so they give a false sense of isolation without enabling tenancy. Either commit to tenancy or drop the columns. **Decided:** single-org, drop the seam. |
| B2 | **Soft retire → grace → revive → GC**, applied to ~10 entity types | Undo accidental deletion; let references drain before hard delete | 🟡 | Strong for **tasks, users, divisions and teams**, where accidental loss is costly. Much weaker for grants, messages, attachments, integration connections and standalone roles, where the undo case is rare and an audit row would do. Each entity type adds a `:revive` action, a revive resolver, two endpoints and GC logic. Around 30 endpoints exist for undo alone. *(revised)* The old docs justify it as one uniform lifecycle plus separately grantable revive (leads retire, admins revive). Real reasons, but the cost still stands. **Decided:** Settled in the requirements session ([intent-vs-reality §6](intent-vs-reality.md#6-requirements-session-2026-11-02)): keep the undo window for task, user, division, team, role and integration connection; grant, message and attachment become hard delete + audit row. |
| B3 | **Grace window in hours, set per org** | Admins decide how long undo stays possible | ✅ | Reasonable. The dead `RETIREMENT_GRACE_DAYS` env var is an accidental leftover from a first version of this decision. |
| B4 | **Users have both `deactivated` and `retired`** | Suspension (temporary, reversible at any time) versus departure (irreversible after grace, PII scrubbed) | ✅ | Two different needs, cleanly separated. |
| B5 | **Scrub-in-place** for users with history | Keep foreign keys and authorship intact while removing PII | 🟢 | Right idea, but the scrub keeps `display_name`, which for most people *is* PII, and leaves Discord links behind (problems D10). The `anonymizeLabel` setting only hides the name when it's displayed. |
| B6 | **`ON DELETE RESTRICT` as the GC backstop** | A bug in reference checking can never delete live data | ✅ | Belt-and-braces, and cheap. |
| B7 | **Optimistic `version` column on almost every row** | Detect lost updates | 🟢 | *(revised, was 🔴)* Optimistic locking on every aggregate was a documented design decision. The use case exists; the checks were never built. Incremented everywhere but checked in exactly one place (submission review), so admin edits are last-writer-wins. |
| B8 | **Invitation status computed when read**, never stored | No status column that could drift from `revoked_at` / `use_count` / `expires_at` | ✅ | Good. |
| B9 | **Activity log: IDs only, strict per-verb schemas** | Keep PII out of an append-only table so a scrub never has to rewrite history | 🟢 | The PII goal is legitimate, but the design overcorrects. `role.updated` doesn't record the old or new name. `config.updated` records which keys changed, not their values. Once GC deletes an entity, every log row about it becomes an unresolvable UUID. The log can say *who touched what* but not *what changed*, which is the main reason to keep an audit log. Non-PII before/after values would cost nothing on the PII side. **Decided:** Settled in the requirements session ([intent-vs-reality §6](intent-vs-reality.md#6-requirements-session-2026-11-02)): record before → after values for configuration and state; never personal data or user-authored text (task names count as user-authored). |
| B10 | **An invalid activity payload throws and fails the business write** | Programming errors surface loudly | 🟢 | Sound in principle. But some activity writes happen *outside* the business transaction, so the "audit is atomic with the change" guarantee only holds on some paths. |
| B11 | **Constraints written by hand in SQL** (XOR `CHECK`s, thread trigger, citext, partial unique index) | Enforce rules Prisma can't express | 🟡 | Each constraint is justified on its own. The cost is that `schema.prisma` no longer describes the database. The attachment XOR in particular exists to support B14's upload-then-move flow. |
| B12 | **Many JSON columns** (`settings`, `constraints`, `answer.value`, `config`, payloads) | Flexibility without migrations | 🟠 | Strong for `question.constraints`, whose shape varies by question type, and for audit payloads. Weak for `organization.settings`, a fixed, known set of about 10 typed fields plus a secret, which only benefits from being typed columns. Weak for `integration_connection.config`, which exists only to carry a plaintext token for backwards compatibility. |
| B13 | **Retired hard-deny lives in authorization**, not in service state checks | Uniform rule: you can't act on something retired | 🔴 | Needs one special resolver for each revive endpoint just to switch it off, and services duplicate the same check anyway (`TASK_RETIRED`, `MESSAGE_RETIRED`). It's state-machine logic placed in an access layer. **Decided:** with undo cut to six entity types (§6.4) and inherent roles gone, far fewer revive paths remain; the state checks move into the domain layer. |

## C. Authorization

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| C1 | **Cedar as the decision engine** | Admins configure permissions as data; clear deny semantics; policies validated against a schema | 🟢 | Justified, and Cedar is the right owner of policy logic. It is used *thinly*, though: authorization runs without a schema, entities are built by hand for each request, the policy text is put together by string concatenation, and reads are outside Cedar entirely (C9). The redesign should give Cedar *more* of the decisions (visibility, state preconditions, self-review), not fewer. |
| C2 | **Closed action vocabulary, defined in code** | Admins can't invent permissions the code doesn't check | ✅ | Correct. |
| C3 | **Each action bound to exactly one resource type** | Lets policies be validated against a schema | 🟠 | Binding every governance action to `Organization` means it can only ever be granted globally. "Team lead manages their team's members" can't be expressed, and `division:update` needed a one-off exception. The use case (validation) doesn't require *this* binding: governance actions could target the entity they act on. |
| C4 | **Grants as matrix cells**: (role, action, effect, scope) | Admin-editable permission matrix | ✅ | A good, understandable model. |
| C5 | **`forbid` grants** | Express exceptions: "everyone in X except role Y" | 🟠 | The deny-exception use case is plausible, but nothing in the codebase or seed data uses it. It also **breaks the admin floor**: the effective-admin count looks only at permits, so a forbid can neutralize every admin while the count still reads greater than zero ([problems D20](current-design-problems.md#d20-a-forbid-grant-can-lock-out-every-admin)). |
| C6 | **Seven scope kinds** | Global, specific unit, own unit, ownership, target role | 🟢 | `own`, `own_division` and `specific_*` have clear uses. `role` scope serves only `user:grant_role` / `revoke_role`, which is a fair use case (delegated role management). But `own` is overloaded: for `task:assign` it means "eligible to claim", which is how leaving got broken (problems D7). |
| C7 | **Membership = holding a unit's inherent role** | `own_division` / `own_team` scopes need a membership fact | 🟠 | A workaround for a missing concept (problems R5). It has no use case of its own; any explicit membership model would serve the scopes better. *(revised)* The old docs intended inherent-role grants to be *pinned* to their unit, but the code never enforced that. **Decided:** make membership first-class and drop inherent roles. |
| C8 | **Policy cache keyed by `config_version`, re-read on every request** | Correct cache invalidation across API replicas | 🟡 | Built for multi-instance correctness, while the rest of the system can't run multi-instance anyway (A5). The version bump also fires on *membership* changes, which don't affect the cached text. Reasonable, but more general than anything needs today. |
| C9 | **Reads not authorized** | A deliberate v1 deferral ("a minor need") | 🔴 | *(revised)* Deferred on purpose, but the deferral didn't hold up. Restricted divisions leak everything, and names become admin-only, which breaks the UI for everyone else (problems R1). **Decided:** design visibility in now. |
| C10 | **Admin list endpoints borrow mutation actions** (`GET /users` ⇒ `user:update`) | Reuse existing actions instead of inventing `*:read` | 🔴 | Seeing the user list requires the power to rename anyone. It follows from C9 and has no use case of its own. |
| C11 | **Validate before activate** (whole policy set strict-validated on every grant write) | An impossible grant can never reach the engine | ✅ | Strong. |
| C12 | **Admin floor** (effective-admin predicate, guarded writes) | The org can never lock itself out | 🟢 | A strong use case. Enforcement covers about 6 of the roughly 10 paths that can remove admin power: division/team retire, integration revokes, Discord unlink, `grant:create` with forbid, and GC role stripping are not covered. It should be one invariant checked at commit time, not something each caller has to remember to wrap. |
| C13 | **Admin power defined as six fixed governance actions** | A concrete definition of "can still administer" | ✅ | Sensible. Should be extended to cover forbids (C5). |
| C14 | **Resolvers attached to HTTP routes** build Cedar resources | Authorization happens before the handler runs | 🟠 | Leads to double loads, to reading unvalidated request bodies, and to fabricated IDs (`'new'`, `'prospective-invitee'`) (problems R6). Authorizing at the domain operation would remove all three. |
| C15 | **Two capability booleans in `/me`** | The UI hides controls the user can't use | 🟠 | Reflecting permissions in the UI is a sound principle, but two booleans can't reflect a scoped matrix. Requesters with real rights get no controls. |
| C16 | **Configurable self-review forbid** (`selfReviewAllowed`) | Small orgs where the requester also does the work | ✅ | A real setting with a real audience. |

## D. Identity & sessions

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| D1 | **Invitations are the only way to create an account** | A closed community; every member is vouched for | ✅ | Strong. |
| D2 | **Bootstrap key printed to stdout** | First admin without SMTP; lockout recovery by restarting | ✅ | Strong and simple. Rotating the key on each restart is right, but it breaks with more than one API replica (problems R2). |
| D3 | **Invite privilege bound, re-checked at redemption** | A leaked or old invite can't grant more than its issuer *now* could | ✅ | Strong. |
| D4 | **Email-bound invites never reveal the bound address** | A leaked link alone isn't enough to redeem | ✅ | Marginal but cheap. |
| D5 | **`max_uses` column** (always 1) | Shareable multi-use invite links | 🟡 | *(revised, was 🔴)* A stated, cheap hedge ("enable multi-use later without a migration"). Still, no API path ever sets it above 1. |
| D6 | **Opaque, DB-backed sessions** (not JWT) | Instant revocation on logout, password reset or retirement | ✅ | Correct for this product. |
| D7 | **Sliding idle expiry written on every request** | Active users stay signed in | 🟢 | The need is real, but writing on every request (reads included) is far more than it requires. Sliding at most once a minute would serve the same need. |
| D8 | **Peppered SHA-256 for every bearer token** | A database leak doesn't leak usable tokens | ✅ | Strong. Then defeated by putting plaintext tokens in the email job queue (problems D12). |
| D9 | **Discord OAuth app credentials in org settings**, encrypted with a key derived from `SESSION_SECRET` | Admins can enable Discord login without editing env and redeploying | 🟠 | The "no redeploy" use case is reasonable but small: OAuth app credentials change almost never. The cost is high: `SESSION_SECRET` becomes a key nobody can safely rotate, and the secret lives in an untyped blob. Env, or a typed secrets table, would serve better. **Decided:** a generic OAuth/OIDC provider slot. Re-home the credential storage when building it. |
| D10 | **Discord sign-in and Discord role-sync linking share one OAuth flow** | A single consent and a single redirect URI | 🟢 | Simple for users, but the two concepts are only half joined: *registering* via Discord creates the sign-in identity but **not** the sync link, while *linking* creates both. Connections created later get no links until each user re-links ([problems D22](current-design-problems.md#d22-discord-registration-and-new-connections-do-not-create-sync-links)). **Decided:** Patrice creates sync links automatically wherever it already knows the member's Discord ID (§6.2). |
| D11 | **Self-service account management** (change password, change email, add a sign-in method) | – | 🔴 | **Absent.** None of these endpoints exist. A Discord-only user is told to "add another sign-in method" before unlinking, and no endpoint lets them do so. A user can never change their email. This is a missing decision, not a weak one. |
| D12 | **Seeded Admin holds only governance, config, user, invite and integration actions**; no member role is seeded | Keep "configure the system" separate from "do the work" | 🟠 | The old docs intended Admin to hold every action. As built, a fresh install can't create a task and invited members can't do anything (problems D29). **Decided:** Admin gets every action at global scope, and an editable Member role with own-scoped work grants is seeded and pre-assigned on invitations (§6.6). |

## E. Work model

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| E1 | **One default request template per division, deep-copied into each task** | Editing the division's form never changes tasks already in flight | ✅ | Strong. "One per division" is a limit (architecture §17), but a reasonable starting point. |
| E2 | **Requester can edit the task's copy until the first submission** | Tailor the form to a single task | ✅ | Strong, with a lock that protects answers already captured. |
| E3 | **Typed questions + per-type JSON constraints + a pure validator** | Structured requests that are validated on the server | ✅ | The best-isolated piece of domain logic in the codebase. |
| E4 | **Question set replaced wholesale on edit** | A simple PUT | 🟠 | Simple, but it makes question IDs unstable and causes the retired-answers crash (problems D6). Diffing by ID would cost little. |
| E5 | **`attachment` question type** | Requests that need a file (artwork, recordings) | 🟢 | The use case is evident. **The web client doesn't support answering it.** The submit dialog filters attachment questions out. A required attachment question therefore makes a task impossible to submit from the UI. |
| E6 | **Multiple openings per task (slots)** | "Need three people to do this" tasks | ✅ | A real use case, and the client handles both the single- and multi-slot case. |
| E7 | **`restrict_claims` on division and team, AND-composed** | Only members may claim this unit's work | ✅ | Strong, and modelled cleanly in Cedar. |
| E8 | **`openings_locked` per division** | Stop requesters expanding capacity in budgeted divisions | 🟡 | Plausible but narrow, and it blocks *reducing* openings as well as adding them, which doesn't fit the stated goal. |
| E9 | **Status as a cached min-rule roll-up** | Fast filtering and sorting on task status | 🟢 | Caching a derived status is fine. Treating that cache as the place to store a decision is not (manual complete, problems R4). |
| E10 | **Manual complete** | The requester declares a task done regardless of outstanding slots | 🟢 | A real need, implemented as a cache overwrite that the next event undoes (problems D5). Needs a stored `completed_at`. |
| E11 | **Versioned submissions with approve / return / reject** | Iterative review with history | ✅ | Strong. |
| E12 | **Reject = final, but the claimant keeps the slot** | Stop a bad actor resubmitting | 🟢 | The "no resubmit" part has a use case. Keeping the slot doesn't: a rejected claimant occupies an opening forever, the roll-up ignores them, and the requester has to evict them by hand to reopen capacity. *(revised)* Intended: the docs free the slot through `retire_submission`, but that path doesn't actually free it. Slot semantics are open (intent-vs-reality §6). *(revised, was 🟠)* **Decided:** the owner confirmed a rejected claimant keeps the seat until the requester acts. Eviction is always allowed and treats the evictee's submission as rejected (§6.1). The cost of evicting by hand is accepted; the gap is that eviction today doesn't mark the submission rejected (problems D28). |
| E13 | **Optimistic lock on review** | Two reviewers acting on the same submission at once | ✅ | The one place B7's column earns its keep. |
| E14 | **Task row lock (`FOR UPDATE`) around capacity changes** | No over-claiming under concurrent claims | ✅ | Correct and minimal. |
## F. Messages, files, notifications

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| F1 | **One task thread, at most one level deep** (trigger-enforced) | Simple discussion with replies, no deep nesting | ✅ | Sound UX choice. Enforcing it with a trigger is fine. |
| F2 | **System messages in the thread** | A timeline of task events next to the discussion | 🟢 | A real UX need. The bodies are English strings with embedded UUIDs, in three formats, parsed by regex in the client (problems R7). It should be a typed event feed. |
| F3 | **Attachments owned by exactly one of a message or an answer**, uploaded to a message then moved to an answer | Every blob has exactly one owner, for GC and authorization | 🔴 | Exclusive ownership is a reasonable goal. Upload-then-move is a workaround with no use case of its own: it requires a message to exist before a submission file can be uploaded, enabled the attachment theft (problems D1), and has no client (E5). An upload staging state ("pending, owned by the uploader") would serve the same goal. |
| F4 | **`StoragePort` with S3 and local-fs drivers** | Cloud deployments and minimal self-hosting | ✅ | Strong. |
| F5 | **Attachment download not authorized** | – | 🔴 | Follows from C9. No use case is stated. |
| F6 | **Whole upload buffered in memory** (multer limit 256 MiB) | Hash the file and check its size before storing | 🟠 | Easy to write. At the configured cap, a few parallel uploads can exhaust the heap. Streaming with an incremental hash would serve the same goals. |
| F7 | **Durable notification rows + content-free SSE ping** | Reliable notifications that work across reconnects, with no payload over the socket | ✅ | A well-designed piece. |
| F8 | **Recipients resolved and stored when the event happens** | Notifications reflect who was involved at that moment | 🟢 | Sound, but the recipient matrix is spread across call sites (eviction gets it wrong, problems D17). |
| F9 | **`event_seq` idempotency** | "Retries are no-ops" | 🔴 | Doesn't work (problems D11), and no retry path exists that would need it. Remove, or key it on a real event ID. |
## G. Discord integration

| # | Decision | Use case it serves | Verdict | Notes |
|---|---|---|---|---|
| G1 | **Sync Patrice roles ↔ Discord roles** | A community that lives on Discord wants roles in both places to agree | ✅ | The core use case is clear and valuable. |
| G2 | **Three sync directions** (inbound, outbound, bidirectional) | Different orgs treat different systems as the authority | 🟢 | Inbound and outbound each have an obvious audience. *Bidirectional* needs the baseline table, attribution logic, a conflict winner, and native-grant special-casing, and it has the most subtle bug (problems D9). *(revised, was 🟡)* **Decided:** Discord is core with full scope, so bidirectional has a confirmed audience. Fix the execution (D9 and ADR 0002's "every write updates the baseline"). |
| G3 | **Sync baseline + `conflict_winner`** | Tell which side changed when they disagree | 🟢 | *(revised, was 🟡)* Required by bidirectional sync, which is now confirmed. ADR 0002's design is sound (attribution first, then audit-log time, then precedence), but the audit-log tiebreak and post-push baseline writes were never built. |
| G4 | **A pure reconciler function** | Testable sync logic | ✅ | Strong. Keep this shape. |
| G5 | **Gateway "doorbell"** (events only enqueue; the reconciler is the only writer) | Near-real-time sync without a second write path | 🟢 | A good pattern. But sessions open **only when the worker boots**: new connections, rotated tokens and retired connections aren't picked up until a restart ([problems D21](current-design-problems.md#d21-gateway-sessions-only-change-on-worker-restart)). |
| G6 | **Adaptive reconcile floor** (6h healthy, 30min degraded) | A correctness backstop that scales with Gateway health | 🟡 | A reasonable idea, but more elaborate than needed, and it measures the wrong timestamp (problems D8). The API's "next reconcile" display uses a *different* formula (`last_sync_at`) from the worker's (`updated_at`). |
| G7 | **`SecretCipherPort` with AEAD, Vault and KMS adapters** | Org-grade secret custody for bot tokens | 🔴 | Only AEAD can encrypt. Vault and KMS can only decrypt values written by "external tooling" that doesn't exist. The API process holds the AEAD key anyway (problems D13), and admins can supply arbitrary `credentialsRef` handles directly. No current user is served by the extra adapters. *(revised)* ADR 0004 intended real cloud custody (the master key never touches Patrice); only half of it was built. |
| G8 | **Governance roles can't be mapped** | Admin revocation must never wait on Discord sync | 🟢 | Strong use case. Only checked when a mapping is created, so it can be bypassed (problems D4). It should be an invariant on grants as well. |
| G9 | **Native vs integration-sourced roles (`user_role.source`)** | Sync never revokes a grant an admin made | ✅ | Strong. But deleting a mapping leaves the integration-sourced roles it granted in place forever ([problems D23](current-design-problems.md#d23-deleting-a-mapping-strands-the-roles-it-granted)). **Decided:** mapping delete and connection retire ask the admin whether to keep these roles as native (default) or revoke them (§6.3). |
| G10 | **Plaintext bot-token fallback** in `config.botToken` | "Backwards compatibility until all connections are migrated" | 🟠 | Pre-release software with no deployed fleet has nothing to stay compatible with. The fallback is now the path used when no key is configured. |
| G11 | **`requireDiscordLink` setting** | Members' Patrice roles must mirror Discord before they touch work | 🟢 | The use case is confirmed (role correctness). Execution fails: it's enforced only in the browser, and non-admins can't read it (problems D14). **Decided:** the API enforces it on task access, it's satisfied by auto-created links to every active connection, and a grantable bypass action handles exemptions (§6.2). |
---

## Decisions without a strong use case, ranked

This list covers the 28 decisions rated 🟡, 🟠 or 🔴, grouped where several share one fix. It also includes six 🟢 decisions (C12, B9, D7, B7, G2/G3, E12) whose flawed execution is especially costly. They are ordered by how much each one costs the system today: in risk, in complexity, or in the bugs it causes. For each, the right-hand column gives the **smallest change that removes the cost**.

| Rank | Decision | Verdict | Cost today | Smallest fix |
|---|---|---|---|---|
| 1 | C9/C10/F5 Reads unauthorized; lists borrow mutation actions | 🔴 | Data exposure; UI shows UUIDs to non-admins | Add read actions to the vocabulary and let Cedar decide visibility |
| 2 | A2 No domain layer (services → Prisma) | 🟠 | Every invariant copied by hand; most defects trace here | Aggregate services that own their invariants; one unit-of-work wrapper for audit, events and floor |
| 3 | C12 + C5 Admin floor partial; forbids ignored | 🟢/🟠 | The org can be locked out | One commit-time invariant that evaluates real Cedar decisions for the governance actions |
| 4 | F3 Upload-then-move attachment ownership | 🔴 | Theft bug; no working client path | Pending uploads owned by the uploader; claim on submit, checking the uploader |
| 5 | C7 Membership as inherent roles | 🟠 | Membership and authority can't be separated; sync can't map membership | First-class `membership(user, unit)`; Cedar parents for units |
| 6 | B13 + revive resolvers: retired hard-deny in the access layer | 🔴 | ~6 duplicate resolvers; duplicated service checks | Lifecycle state checks in the aggregate; Cedar for *who* only |
| 7 | A7 Queue no-op degradation | 🔴 | Email and sync lost silently | Fail loud on enqueue; report degraded on `/health` |
| 8 | C14 Route-attached resolvers | 🟠 | Double loads, unvalidated reads, fabricated IDs | Authorize inside domain operations, using already-loaded entities |
| 9 | G7 + G10 Cipher adapter zoo + plaintext fallback | 🔴/🟠 | False custody claim; plaintext tokens | One mandatory key, held by the worker only; API sends plaintext to the worker over the queue, or encrypts with the worker's public key |
| 10 | D9 OAuth secret encrypted with a `SESSION_SECRET`-derived key | 🟠 | Secret that can't be rotated; four uses for one key | Separate keys per purpose; typed secret storage |
| 11 | E12 Rejected claimants keep their slot | 🟢 | Openings held until the requester acts | **Decided: keep.** Make eviction mark the evictee's submission rejected (D28) |
| 12 | B1 Singleton org with tenant columns | 🔴 | Misleading isolation; extra joins and filters | **Decided:** drop the columns (single-org) |
| 13 | C3 One resource type per action, governance = `Organization` | 🟠 | Delegated administration can't be expressed | Governance actions target their real entity |
| 14 | B9 Audit log is IDs only | 🟢 | "What changed" can't be answered | **Decided:** values for config and state; never personal data or user-authored text |
| 15 | G2 + G3 Bidirectional sync with baseline | 🟢 | The subtlest bug in the system; the most code | **Decided: keep.** Implement ADR 0002 as written: baseline updated after every push, audit-log tiebreak |
| 16 | B2 Retire/revive on every entity | 🟡 | ~30 endpoints and actions for undo | **Decided:** keep for task, user, division, team, role and connection; hard delete + audit for grant, message and attachment |
| 17 | E4 Wholesale question replace | 🟠 | Unstable IDs; FK crash | Diff by question ID |
| 18 | C15 Two capability booleans | 🟠 | UI can't reflect scoped rights | Per-entity `allowedActions` from Cedar on read |
| 19 | B12 Untyped `settings` blob | 🟠 | Shape drift; secret stored next to toggles | Typed settings columns or table |
| 20 | F9 `event_seq` | 🔴 | Duplicate/drop behaviour | Key on a real event ID or remove |
| 21 | B7 `version` column everywhere | 🟢 | Implies a protection that isn't there | Implement the documented version-guarded updates in the domain layer |
| 22 | D5 `max_uses` | 🟡 | Dead generality | Keep as the documented hedge, or expose multi-use invites deliberately |
| 23 | F6 In-memory upload buffering | 🟠 | Memory exhaustion risk | Stream with an incremental hash |
| 24 | G6 Adaptive floor | 🟡 | Wrong clock; two formulas | One fixed floor measured on `last_sync_at` |
| 25 | C8 Policy cache tuned for multi-instance | 🟡 | Extra query on every request | Fine to keep; drop the membership-triggered bumps |
| 26 | B11 Constraints only in SQL | 🟡 | Schema file incomplete | Acceptable; document them next to the model |
| 27 | E8 `openings_locked` | 🟡 | Blocks decreases as well | Lock increases only, or drop |
| 28 | D7 Slide on every request | 🟢 | Write amplification | Slide at most once a minute |
| 29 | D11 No account self-management | 🔴 | Users stuck with an email or sign-in method | Add change-password, change-email (re-verify) and add-identity |
| 30 | D12 Seeded Admin lacks work actions; no Member role | 🟠 | A fresh install can't do any work | **Decided:** Admin gets every action; seed an own-scoped Member role pre-assigned on invites |

---

## Decisions that should survive the redesign unchanged

For balance: these have strong use cases and sound implementations. The redesign should keep them as they are.

- PostgreSQL as the only stateful dependency, with pg-boss on top (A3, A6)
- UUIDv7 keys and cursor pagination (A4)
- Environment validated by Zod at boot, failing fast (A9)
- Same-origin `/api` behind one proxy (A8)
- Deactivated vs retired users (B4)
- `RESTRICT` as the GC backstop (B6)
- Invitation status computed on read (B8)
- Cedar as the engine; a closed vocabulary; grants as matrix cells; validate-before-activate (C1 idea, C2, C4, C11)
- Admin power defined as the governance actions (C13)
- Configurable self-review (C16)
- Invite-only accounts, the bootstrap key, the invite privilege bound, email knowledge factor (D1–D4)
- Opaque DB sessions; peppered token hashes (D6, D8)
- Template deep-copy plus lock at first submission; typed questions with a pure validator (E1–E3)
- Multiple openings; AND-composed claim restriction; versioned review with optimistic lock; task row locks (E6, E7, E11, E13, E14)
- One-level threads; the storage port; durable notifications with content-free pings (F1, F4, F7)
- The pure reconciler; the Gateway doorbell pattern; tracking native vs integration-sourced grants (G4, G5 idea, G9)
- Seeding through the HTTP API rather than writing to the database, so every invariant is honoured (`api/scripts/seed.mjs`)
