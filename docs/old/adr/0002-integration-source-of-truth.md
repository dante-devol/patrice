# ADR 0002 — Integration sync: reconciler + per-edge baseline, attribution before tiebreak

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context slice:** Discord integration (issue #46), bidirectional + Gateway in v1

## Context

The Discord integration syncs role membership both ways (`sync_direction` ∈
`inbound | outbound | bidirectional`). The reconciler is the **sole writer** of
`user_role` (the Gateway listener is a Doorbell that only enqueues; see ADR on process
topology). Bidirectional sync ships in v1, which raises the feedback-loop /
conflict-resolution question the issue body deferred as an open decision.

The issue described conflict handling as "LWW by `updated_at` + source tiebreak." Grilling
exposed that this can't mean what it says: `GET /guilds/{id}/members` returns the *current*
role set, never *when* a role was assigned, so there is **no per-edge Discord-side
timestamp** to time-order against. Cross-boundary LWW is not observable from REST.

## Decision

Sync is **desired-state reconciliation over a binary Edge** — one `(connection, external
user, mapped group)` membership fact, present or absent on each side — anchored to a **Sync
Baseline**: the last-converged state of each Edge.

**1. Attribution settles the normal case, with no tiebreaker.** For a binary Edge against a
trustworthy baseline, the two sides can only *disagree* if exactly one diverged from the
baseline (if both moved off a single-valued baseline they'd agree). That side is the
unambiguous origin; its state propagates. Time and precedence are never consulted here. This
holds only because **every write updates the baseline, including the bot's own outbound
pushes** — that is what keeps attribution trustworthy and the writer from re-reacting to
itself.

**2. Tiebreak only on a Cold-Baseline Conflict** — first sync, or a lost/never-converged
baseline, where attribution can't tell who changed. Resolve by **Discord audit-log time**
when the entry is fetchable (the only authoritative Discord-side change-time), else by a
per-mapping **Source Precedence** (`conflict_winner ∈ patrice | external`, default
`patrice`). Precedence is per-mapping, not global, because `sync_direction` is already
per-mapping.

**3. The Sync Baseline is a dedicated sparse table** keyed on external coordinates
`(connection_id, external_user_id, external_group_id)`; a row means "present at last
convergence," absence means absent. External-keyed (like the rest of the adapter, which maps
by snowflake) so Patrice-side renames don't break it. A converged reconcile bulk-upserts the
present Edges and deletes the now-absent ones.

**4. Teardown orphans, never reclaims.** The locked outbound scope — "only adds/removes the
mapped role on linked members, never touches unmapped roles or unlinked members" — already
decides this: unlink (scrub/GC today), mapping-delete, and connection-retire all leave the
pushed Discord roles in place (Patrice stops managing them). No automatic mass-strip; an
explicit admin "remove from all members" action is deferred. The **baseline rows**, however,
are GC'd on scrub/GC, mapping-delete, and connection-GC (kept through the retire Grace
Period for clean revive) — a stale baseline would otherwise manufacture a phantom "Discord
removed it" attribution on revive/relink.

## Consequences

- "LWW" is retired from the vocabulary for cross-boundary conflicts; `updated_at` ordering
  is valid only *within* Patrice. The honest model is attribution-primary, audit-log-time
  then precedence on cold baselines.
- The audit-log fetch is consulted **only on a conflict**, so its rate-limited, best-effort
  nature is acceptable — it is an enhancement over precedence, never the primary path.
- A new `sync_baseline` table and its GC triggers are required before outbound /
  bidirectional and the Gateway Doorbell (the M2.5 prerequisite).
- The dual-write seam (Discord PATCH then baseline upsert is not atomic) means a crash
  between them can drop a baseline write → a manufactured conflict on the next run, resolved
  by the cold-baseline path and self-healing on the following converged run. Idempotent
  re-PATCH keeps convergence safe; only bidirectional attribution is briefly affected.
