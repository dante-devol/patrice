# Slice 7 — Retirement & Garbage Collection

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** all prior slices (it touches every entity).*

**Goal.** Make the **lifecycle** real: retiring entities denies all action on them (hard-deny), they
can be **revived** within a configurable **grace period**, and a **lazy GC sweep** permanently
deletes those past grace with no live references — including **task-aggregate** deletion, **user
scrub-in-place**, and **orphaned-blob** cleanup.

**Acceptance demo.**
1. Retire a task → every action on it returns **403** (hard-deny); it disappears from default
   (active-only) lists; it still appears in admin/history views.
2. **Revive** the retired task within the grace window → it's active again.
3. Advance time past the grace period and run the **GC sweep** → the task **and its aggregate**
   (messages, submissions, answers, claimant slots, attachments) are deleted; the attachment **blobs**
   are removed from object storage.
4. Retire a **division** with no live references → after grace, GC deletes it (its inherent role too).
   A division still referenced by an active task is **not** deleted (RESTRICT backstop).
5. **Fully retire a user with history** → after grace, scrubbed to a tombstone (GUID + `display_name`
   kept; email/PII nulled; `user_identity`/`session`/etc. purged); their authored messages/submissions
   still resolve to the tombstone. A user with **no** history is deleted outright.

**In scope.** The `retire`/`revive` actions across entities (most `*:retire` already exist); the
**retired-as-hard-deny** wiring in the access engine (the static `forbid` from Slice 1, now exercised
for real); the **soft-retire default filter** (active-only by default; admin/history views opt out);
the **grace period** config; the **lazy GC sweep** (pg-boss scheduled job): `EXISTS`-over-known-
referrers, aggregate deletion, user scrub-in-place, RESTRICT backstop, orphaned-blob reconciliation.

## Mechanics
- **Retire** sets `lifecycle_state='retired'`, `retired_at=now()`, bumps `config_version` (so the
  engine re-projects and the `forbid` applies). **Revive** is the inverse — but each resource has
  its **own action** (`task:revive`, `role:revive`, `division:revive`, `team:revive`,
  `grant:revive`, `message:revive`, `attachment:revive`, `user:revive`) registered in Slice 2's
  vocabulary, **not** an implicit corollary of `*:retire`. Admin holds the full set by default;
  delegate narrower revive authority via grants. **State-machine guard:** revive is only valid
  while `lifecycle_state='retired'` AND `retired_at > now() - grace_period` (pre-GC). Outside the
  guard → `409 NOT_REVIVABLE` (post-GC: row no longer exists; pre-retire: nothing to revive).
  Cedar gates *who*; the guard gates *whether*.
- **`user:reactivate`** (Slice 2's vocabulary) is the in-life deactivation reversal — distinct
  from `user:revive` (post-retirement-pre-GC). The two cover the two reversibility axes.
- **Retired-as-hard-deny:** the engine's static `forbid(when resource.retired)` denies every action
  whose **target/actor** is retired. *Block also covers new references* to a retired entity (e.g.
  creating a task in a retired division) — enforced at the write. *Existing* references may complete
  their lifecycle (so the entity can reach zero refs).
- **Soft-retire default filter (Prisma Client Extension):** queries default to
  `WHERE lifecycle_state='active'`; explicit opt-in for admin/history.
- **Grace period:** a configurable window (startup/ops config, default e.g. 24h). GC **skips**
  anything `retired_at > now()-grace` — guaranteeing a revive window independent of sweep timing.
- **GC sweep (pg-boss, long cadence — e.g. hourly):** for each retired-past-grace entity, run `EXISTS`
  checks over its **known referrer tables** (static FK graph). If unreferenced:
  - **Task aggregate:** delete task + its messages, submissions, answers, claimant slots, attachments
    **as a unit** (gated on no *external* refs; `activity` is exempt — never a refcount).
  - **Role/division/team:** delete individually (RESTRICT backstop means a still-referenced row's
    delete simply fails and is retried next sweep).
  - **User with history:** **scrub-in-place** — keep `id` + `display_name`, set `retired`, null
    `email`/PII, purge `user_identity`/`external_identity`/`session`/`auth_token`/`notification`, strip
    `user_role`. **Never moved** (FKs to `app_user.id` must stay valid). A history-less user is deleted
    outright. (This is also the GDPR-style data-erasure path; the `organization.settings.anonymizeLabel`
    flag — Slice 2 — replaces the rendered name with "Former member" when set.)
    - **Additional scrub steps** (cross-slice consequences):
      - **Auto-revoke pending invitations issued by this user:** `UPDATE invitation SET
        revoked_at=now() WHERE created_by=$userId AND revoked_at IS NULL` in the same
        transaction. Write one `activity` row per invite: `verb='invite.auto_revoked_on_issuer_retired'`,
        `actor_user_id=NULL` (system), payload IDs-only. *(Deactivation is passive — pending invites
        remain redeemable and rely on Slice 1's redemption-time re-validation; only the
        irreversible retirement triggers the proactive revoke.)*
      - **Null `invitation.email` for invites the user *received*:** any `invitation` row where the
        invite resolved to this user (via `invitation_use.created_user_id = $userId`) has its
        `email` field nulled. The `invitation_use` audit row itself survives (IDs-only).
      - **No activity-payload scrub needed** by construction — Slice 1's `logActivity` helper
        forbids PII strings in payloads, so the scrubbed user's display continues to render via
        join-to-current-state with tombstone fallback ("Former member" when `anonymizeLabel`).
  - **Object storage:** after a successful DB delete, delete the attachment **blobs**; plus a periodic
    **orphaned-blob reconciliation** (list store vs. `attachment` rows) so a crash mid-delete can't
    leak storage.

## API endpoints
```
POST  /<resource>/:id/revive       (gated by the resource-specific *:revive action — task:revive,
                                    role:revive, etc.; see Slice 2 vocabulary)
POST  /users/:id/reactivate        (user:reactivate)   -- the deactivation→active arrow, distinct from revive
GET   /<resource>?include=retired  (admin/history views opt out of the active-only filter)
-- GC runs as a scheduled pg-boss job with `singletonKey: 'gc-sweep'` so multi-instance
-- topologies don't double-sweep. Expose an admin "run sweep now" + a dry-run for testing.
```

## Web (Angular)
- Retired entities marked in admin lists; a **Revive** action where permitted; history toggles that
  include retired rows. Inline "this is retired" denial messaging when an action is attempted.

## Tests
- Retire → all actions 403; removed from active lists; revive restores (within grace).
- GC dry-run identifies exactly the past-grace, unreferenced entities.
- Task-aggregate deleted as a unit; `activity` rows survive; blobs removed.
- RESTRICT: a still-referenced division survives the sweep; once dereferenced, next sweep deletes it.
- User scrub: history-bearing user → tombstone (authored content still resolves to the label);
  history-less user → fully deleted; `anonymizeLabel` honored.
- Orphaned-blob reconciliation removes a leaked blob.

**Done when** the demo passes — the full retire → grace → revive → GC lifecycle works for every entity
type, including user scrub.
