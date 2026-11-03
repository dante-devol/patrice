# Patrice: Documented Intent vs. Built Reality

> **Fourth companion** to [current-architecture.md](current-architecture.md), [current-design-problems.md](current-design-problems.md) and [current-design-decisions.md](current-design-decisions.md). Those three were written from the code alone. This one compares them against the original design documents (now in [`docs/old/`](old/)): the PRD, `ARCHITECTURE.md`, ADRs 0001–0006, the slice plans and the Discord bot sketch.
>
> **The old docs are evidence of intent, not the source of truth.** Where intent and code disagree, neither side wins automatically. Small gaps are classified below. **Wide gaps were taken to the project owner**, and the resulting direction decisions are recorded in §1.
>
> Snapshot: `main` at `c322ae2`; decisions taken 2026-11-02. The implementation plan that follows from them is [redesign-plan.md](redesign-plan.md).

---

## How to read this

| § | Section | What it tells you |
|---|---|---|
| 1 | [Direction decided](#1-direction-decided-2026-11-02) | Eight decisions from the owner. **The redesign follows these, not the old docs.** |
| 2 | [Intent sound, code diverged](#2-intent-sound-code-diverged) | The docs had it right and the code drifted. Treat these as defects. |
| 3 | [Code diverged deliberately](#3-code-diverged-deliberately-and-documented-it) | Documented, reasoned departures. Accept them. |
| 4 | [Where the docs supplied a missing rationale](#4-where-the-docs-supplied-a-missing-rationale) | Verdicts in the decision register that changed because of this comparison |
| 5 | [Where the docs are wrong or stale](#5-where-the-docs-are-wrong-or-stale) | Don't carry these forward |
| 6 | [Requirements session](#6-requirements-session-2026-11-02) | The open questions, now settled with the owner |

---

## 1. Direction decided (2026-11-02)

Each of these was a wide gap between the docs and the code. The owner chose a direction for the redesign.

| # | Question | Old docs said | Code does | **Decision** |
|---|---|---|---|---|
| 1 | Internal shape and contract | Ports & adapters with repository ports; REST + OpenAPI emitted from Zod; generated Angular client | Services call Prisma directly; web types written by hand; no OpenAPI | **Do both.** A real domain layer, and an OpenAPI contract emitted from Zod with a generated client. |
| 2 | Membership | Holding a unit's inherent role *is* membership; that role's grants are **always** pinned to its unit | Inherent roles exist, but their grants are never pinned (they can be global) | **Separate membership from authority.** `membership(user, unit)` becomes first-class; authority comes only from roles; inherent roles go away. |
| 3 | Read visibility | Deliberately deferred as a "minor need" | Ungated; non-admins can't even resolve names | **Design it in now.** Read actions join the vocabulary, and Cedar decides visibility, restricted divisions included. |
| 4 | Discord's role | Optional, post-v1 (Slice 8), last-write-wins sync, never an auth path | Shipped in v1: bidirectional sync with a baseline, live Gateway, three cipher backends, Discord login | **Core, full scope.** Keep login, all three sync directions and the Gateway, and fix what is broken (§2). |
| 5 | Topology | Single API in v1, with "seams" for HA; ADR 0003 describes N API replicas + 1 worker | Split exists, but in-memory state breaks with more than one API | **One API + one worker**, sized for ~200 users / ~100k tasks. Drop the "scale-ready" claims, and move state into Postgres only where it's cheap. |
| 6 | Tenancy | Single org, but keep an `organization_id` seam on every table for later | Seam applied inconsistently | **Single-org; drop the seam.** Remove `organization_id`. |
| 7 | Login providers | Password + **Google** as primary; Discord maybe | Password + Discord; Google never built | **A generic OAuth/OIDC provider slot.** Ship password + Discord; others plug in later without rework. |
| 8 | Claimant slot semantics | Leave after submitting keeps the slot consumed; retiring a submission frees the slot for anyone | Any leave frees the slot; a retired submission returns the slot to the same claimant | **Decided in requirements session (§6.1).** A slot is a seat; no leaving after submitting; retire frees the seat; reject keeps it. |

**What these decisions change in the other documents**
- **Decision 2** settles problems R5 and D2, and register rows C7 and B13. It also removes the need for the docs' "inherent-role grants are always `specific_*`" rule.
- **Decision 3** settles R1 and register rows C9, C10, F5 and C15.
- **Decision 4** upgrades register rows G2 and G3 from 🟡 to 🟢. Bidirectional sync now has a confirmed audience; its remaining problem is execution (D9).
- **Decision 5** settles R2's direction. Fix the per-module role checks, but don't build LISTEN/NOTIFY.
- **Decision 6** settles R9 and B1.

---

## 2. Intent sound, code diverged

In each of these the old docs described sensible behaviour and the code doesn't implement it. Unless §1 overrides it, **treat each as a defect for the redesign to fix.** Where the problems doc already covers the item, it's cross-referenced.

### 2.1 Work model

| Documented intent | Source | Reality | Ref |
|---|---|---|---|
| A claimant who leaves *after submitting* keeps the slot consumed. Their submission still counts, and the requester adds an opening for a replacement. Departed claimants' submissions still need resolving. | ARCH §2.5, §6.4; Slice 4 | `leave()` never checks `has_submitted`. Leaving frees the slot, and the recompute ignores the departed claimant's submission entirely. | **New.** Semantics still open (§1 #8) |
| Retiring a submission makes the slot **claimable again** (by anyone). | Slice 5 | Only `has_submitted` is cleared. The original claimant still holds the slot. | **New.** Open (§1 #8) |
| Retired entities block **new references**: no assigning a retired user or role, no new task in a retired division. | ARCH §2.10; Slice 7 | New tasks in retired divisions *are* blocked. Granting a role **to a retired user**, or granting a **retired role**, is not. | D27 (partly) |
| **Optimistic locking** on every mutable aggregate root, via a version-guarded update in a repo helper. | ARCH §2.10, §4.10, §5.1; Slice 0 conventions | The column exists but is checked only on review. Every other edit is last-writer-wins. | Register B7 (now 🟢) |
| Manual complete forces Approved; outstanding submissions are shown as "no longer required". | Slice 5 | Forced into the cache, then overwritten by the next recompute. | D5 |
| The questionnaire validator is a portable artifact **shared with the Angular renderer**. | PRD; ARCH §4.9 | Server-side only. The web app doesn't validate client-side and filters out attachment questions. | D25 |

### 2.2 Authorization & identity

| Documented intent | Source | Reality | Ref |
|---|---|---|---|
| `team:create/update/retire/revive` and `invite:create/retire` are **scopable** (S). Per-division admin tiers exist. | ARCH §2.3 | All bound to `Organization`, so they can only be granted globally. Per-division admins can only edit their division's template. | Register C3 |
| Baseline self-access covers **own profile, own session list, own claimed/requested tasks**. | ARCH §2.3 | Only `user:update` on yourself. | **New** |
| Privileged users can **view and revoke** others' sessions (`session:revoke @ global`); `/auth/logout` is gated by `session:revoke @ own`. | ARCH §2.11; Slice 2 | No session list or revoke endpoints exist. Logout isn't gated. `session:revoke` is registered but unused. | **New** |
| The seeded Admin role holds global grants **for every action**. | ARCH §2.8 | Seeds governance, config, user and integration actions only. No `task:*`, `message:*` or `attachment:*` grants, so a fresh install can't create tasks until the matrix is edited. | **New** |
| The admin floor covers removing the last admin's governance grant, retiring, deleting or deactivating the last admin, and stripping the Admin role's grants. | ARCH §2.8; Slice 2 | Partial: misses division/team retire, integration revokes, unlink and grant create, and ignores forbids. | D2, D20 |
| The role entities of the acting user are **cached and version-stamped** alongside the policy set. | ARCH §2.3, §4.4 | Re-queried on every decision. | Register C8 |
| `retired_block` notifications plus UI that *motivates* resolving blocks caused by retired data ("rectification emerges"). | ARCH §2.10, §2.12 | The notification type is declared but never emitted. The UI has no such guidance. | **New** |
| Scrub purges `external_identity`. | ARCH §2.10; PRD | Doesn't. | D10 |
| Lost sole sign-in method: **admin-assisted** recovery (re-invite or attach a method). | ARCH §2.2, §6.4 | No API to attach a method, for admins or for users. | D24 |

### 2.3 Integration & topology

| Documented intent | Source | Reality | Ref |
|---|---|---|---|
| **Every write updates the baseline, including the bot's own outbound pushes.** The ADR calls this load-bearing for attribution. | ADR 0002 | The baseline is written from the *pre-apply* external snapshot, so outbound pushes aren't recorded. | D9 |
| Cold-baseline conflicts break ties by **Discord audit-log time** when available, then by precedence. | ADR 0002 | Only precedence (`conflict_winner`) is implemented. | **New** |
| The bot-token key is provisioned to the **worker only**; the API holds neither token nor key. | ADR 0003, 0004, 0006 | The API encrypts with the same symmetric key. Production compose gives both processes one `.env`. | D13 |
| Vault and KMS custody "for cloud": the master key never touches Patrice. | ADR 0004 | Decrypt-only. `encrypt` always uses AEAD. | Register G7 |
| **Every background starter guards on `ProcessRole`**, with a test asserting the API opens no socket and schedules no cron. | ADR 0003 | Email and GC don't guard. The ADR itself calls this "hygiene, not correctness" for queue consumers, which softens R2 for those two. | R2 |
| A pre-split assertion that **no `PubSubPort.publish` runs in the worker**. | ADR 0003 | No assertion exists. The worker writes notification rows without publishing, so the outcome is consistent, but the code doesn't guard it. | **New** |
| Teardown "orphans, never reclaims" on the **Discord** side. Baseline rows are GC'd on mapping delete. | ADR 0002 | Matches. The ADR is silent about **Patrice-side** integration-sourced roles after a mapping is deleted, which is where D23 lives. | D23 (gap in the ADR too) |
| Integration tests run against the **real pg-boss queue** (synchronous mode). | PRD testing | E2E tests run with `DISABLE_QUEUE=true`. | R8 |
| A soft-retire default filter via **Prisma Client Extensions**. | ARCH §4.10 | A manual `activeFilter()` per list query. | Register A2 |

---

## 3. Code diverged deliberately and documented it

These departures from the original design come with a written rationale, in an ADR or a code comment, that holds up. **Accept them** and drop the older wording.

| Original design | What was built | Why it's acceptable |
|---|---|---|
| Grants as Cedar **template-links**; scope via `resource in ?group` hierarchy | One annotated static policy per grant; scope via attributes | Cedar templates can only slot principal and resource, not actions or scalar values (explained in [`policies.ts`](../api/src/access/cedar/policies.ts)). It keeps the invariant that mattered: a fixed shape library and one policy per grant. *Decision 2 (membership) is a good moment to revisit the hierarchy approach, since units can become Cedar parents.* |
| Cross-boundary sync by **last-write-wins on `updated_at`** (PRD story 72, ARCH guiding context) | Desired-state reconciliation with a per-edge baseline and attribution | ADR 0002 shows LWW isn't observable: Discord's REST API exposes no per-edge timestamps. The replacement is better reasoned; it just wasn't fully implemented (§2.3). |
| Discord is **never an auth path** | Discord is a first-class `user_identity` provider, separate from the sync link | ADR 0005 keeps the actual invariant (login doesn't depend on any integration connection) while narrowing the wording. Consistent with Decision 7. |
| OAuth client secrets live in **startup config** (env) | The Discord OAuth secret lives in org settings, encrypted with a key derived from `SESSION_SECRET` | ADR 0006: admins configure it without redeploying. The reasoning is sound, but the key coupling it creates is still flagged (register D9). Revisit under Decision 7's provider slot. |
| `division:update` grouped with governance (global only) | Scoped to the Division resource | ADR 0001. A deliberate fix. |
| Scale-out "seams" (Postgres LISTEN/NOTIFY etc.) | Not built | ADR 0003 deferred them knowingly. Decision 5 makes the deferral permanent. |

---

## 4. Where the docs supplied a missing rationale

The [decision register](current-design-decisions.md) was written from the code alone, and some verdicts read "no stated use case" where the docs did state one. These rows were revised:

| Register row | Was | Now | Why |
|---|---|---|---|
| **B2** Retire/revive on ~10 entity types | 🟡 | 🟡 (rationale noted) | The docs justify it as *one uniform lifecycle*, so admins don't memorize per-entity deletion rules, plus *separately grantable revive* (leads retire, admins revive). Real reasons, but the cost of ~30 endpoints still stands. |
| **B7** `version` column everywhere | 🔴 | 🟢 | Optimistic locking on every aggregate was a design decision. The column has a use case; the checks just weren't built. |
| **C9** Reads unauthorized | 🔴 "no stated use case" | 🔴 "deliberate deferral that didn't hold" | Deferred on purpose as a "minor need". The consequence that names are admin-only wasn't foreseen. Decision 3 reverses the deferral. |
| **D5** `max_uses` | 🔴 | 🟡 | A stated, cheap hedge: "kept so multi-use can be enabled later without a migration." Still unused. |
| **E12** Rejected claimant keeps slot | 🟠 | 🟠 (rationale noted) | Intended: the requester frees it via `retire_submission`. But that path doesn't actually free the slot (§2.1), so the intended escape hatch doesn't work. |
| **G2 / G3** Bidirectional sync + baseline | 🟡 | 🟢 | Decision 4 confirms the audience. The remaining issue is execution (D9 and §2.3). |
| **R3 note** Tasks in a retired division stay operable | listed as an inconsistency | **intended** | ARCH §2.10: existing references may "complete their lifecycle", which is what lets the division reach zero references and be collected. |

---

## 5. Where the docs are wrong or stale

Don't carry these into the redesign's documentation:

- **[`discord-bot-design.md`](old/discord-bot-design.md) is obsolete.** It describes a separate bot process, a plaintext `config.botToken`, and per-connection OAuth redirect URIs. All three were superseded by ADRs 0003–0006.
- **"Patrice custodies no long-lived integration secret"** (ARCH §2.8, §6.3). Superseded by ADR 0004.
- **"Postgres 16+"** (PRD, slice overview). The schema needs **PG18** for `uuidv7()`.
- **Discord as "post-v1"** throughout the PRD and slice plan. It shipped in v1 (ADR 0002 says so), and Decision 4 makes it core.
- **The test-framework suggestion (Vitest + Testcontainers).** Jest with a CI Postgres service was used. Harmless, but the docs never recorded the switch.
- **The effective-admin predicate wording.** ARCH §2.8 lists `grant:update`, `role:create/update/retire`, while the glossary and code use all six governance actions. The code follows the glossary.
- **Several documented requirements are no longer recorded anywhere.** `requireDiscordLink`, the reconcile floor, the Gateway doorbell and the observability columns were added without design docs. Their intent exists only in code comments and issue numbers (#52, #57–#62).

---

## 6. Requirements session (2026-11-02)

These were open after the comparison and were settled with the owner in a requirements session. Like §1, **the redesign follows these.**

### 6.1 Settled: slot semantics (Decision 8, requirements session 2026-11-02)

| Question | Decision | Change from today's code |
|---|---|---|
| What is a slot? | **A seat that a person occupies**, not a deliverable. The defining case is QA testing: several testers on one task, each making their own structurally similar submission. | None (the code already treats slots as seats) |
| Can a claimant leave after submitting? | **No.** Leaving is only possible before your first submission. To withdraw afterwards, the requester retires your submission. | `leave` must refuse when the claimant has a live submission |
| What does retiring a submission do to the seat? | **Removes the claimant and opens the seat for anyone.** Retire never offers a redo; *return* (revising) is the redo path. | Today the claimant keeps the seat and can resubmit |
| What does rejecting a submission do to the seat? | **The claimant keeps the seat** (unable to resubmit) until the requester acts. | None |
| Can the requester evict a claimant who has submitted? | **Yes, always.** The evicted claimant's submission stays on the task as a record and is **treated as rejected**: no resubmission, and it's excluded from the status roll-up, whatever state it was in (approved included). The seat opens. | Today eviction drops the claimant from the roll-up, but the submission keeps its state, so an evicted "review" submission is never resolved |

### 6.2 Settled: `requireDiscordLink` (requirements session 2026-11-02)

| Question | Decision |
|---|---|
| Purpose | **Role correctness.** Members' Patrice roles must mirror Discord before they touch work. |
| What it gates | **Task access**: task, submission, message and attachment reads (once visibility exists) and actions. Account, profile, Discord linking, and admin settings and integrations stay reachable. **Enforced by the API.** Per the "Cedar owns policy" principle, the natural form is a static Cedar `forbid` over task-family actions when the setting is on and the principal isn't synced. |
| What satisfies it | **A sync link to every active Discord connection.** Patrice **creates links automatically** whenever it already knows the member's Discord ID (Discord registration, an earlier link, or a newly added connection), which fixes problems D22. With **no active Discord connection**, the gate is off. |
| Exemptions | **A grantable bypass action** (e.g. `task:bypass_discord_gate`) in the closed vocabulary, assigned through the matrix to roles such as contractors who aren't on Discord. No automatic admin exemption; admins are never locked out of *fixing* things, because the gate covers only task access. |

### 6.3 Settled: Patrice-side cleanup of integration-granted roles (requirements session 2026-11-02)

ADR 0002's "orphan, never reclaim" still governs the **Discord** side. On the **Patrice** side:

| Event | Decision |
|---|---|
| **Mapping deleted** | The admin chooses at delete time, after seeing the count of roles it granted: **keep them as native** (the default; `source` becomes `patrice`) or **revoke them**. Revocations run under the admin floor and are audited. Never leave them as integration-sourced orphans (fixes problems D23). |
| **Connection retired** | Sync **pauses**; integration-sourced roles stay as they are through the grace period. The admin picks their fate **at retire time** (keep as native by default, or revoke), and it is **applied when the connection is collected** after grace. **Revive** cancels the pending choice, and sync resumes cleanly. |

### 6.4 Settled: undo scope (requirements session 2026-11-02)

| Retire → grace → revive → GC | Hard delete + audit row |
|---|---|
| Task, User, Division, Team, Role, Integration connection | Grant, Message (a "deleted" marker may remain in the thread), Attachment |

Submission retire stays a moderation removal with a reason and no revive (§6.1). Message restore isn't needed. This retires roughly 12 revive endpoints, actions and resolvers (register B2, B13).

### 6.5 Settled: audit content (requirements session 2026-11-02)

Audit rows record **before → after values for configuration and state**, and **IDs only for personal data and user-authored content**:

| Recorded as values | ID only, never values |
|---|---|
| Role, division and team names; settings values (secrets redacted); grant shape (action, effect, scope); openings, flags, restrict-claims; status, review decision, submission number, sync counts | User email, display name, Discord handle or avatar, IP or user agent; task names and descriptions; message bodies; answers; filenames |

Personal data is shown by joining to current state, so a scrub covers it. **The submission-retire reason lives only in the task-thread audit message**; the activity row references that message by ID. It's no longer copied into the append-only log (fixes the D18 exception). This supersedes the old "IDs only" Activity Payload Discipline and register B9.

### 6.6 Settled: seeded roles (requirements session 2026-11-02)

| Role | Decision |
|---|---|
| **Admin** | Seeded with **every action at global scope**, as the old docs said. When an upgrade adds actions, they're added to Admin's seed too. It stays an ordinary, editable role; the effective-admin floor protects the governance subset. |
| **Member** (new) | Seeded as an editable starter role with **own-scoped work grants**: claim/leave and submit (`@ own`); `message:create` and `attachment:create`; edit and delete own messages and attachments; `task:create @ own_division`; and update, retire, review, complete and manage claims on tasks they requested (`@ own`). **New invitations pre-assign Member by default**; the inviter can untick it. |

### 6.7 Still open

None. All six questions that this section originally listed (slot semantics, `requireDiscordLink`, Patrice-side cleanup, undo scope, audit content, seeded Admin grants) are settled in §6.1–6.6, along with the follow-ups they raised (eviction, gate exemptions, connection retire, the retire reason, the Member role).
