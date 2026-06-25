# ADR 0003 — Process topology: one image, a `PROCESS_ROLE` toggle (api vs worker)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context slice:** Discord integration (issue #46), the Gateway Doorbell in v1

## Context

The Gateway Doorbell needs a **persistent websocket** — a stateful singleton with the
opposite operational profile from the request tier (horizontally scalable, freely
restartable). The API already runs background work in-process (pg-boss consumers, the daily
cron, GC) via `onModuleInit`, the classic web/worker co-location. The Gateway adds the
qualitatively new constraint: a socket that **cannot be horizontally replicated** (N api
replicas → N× duplicate events) and **would be bounced by every API deploy** — coupling the
fast-revocation path to deploy cadence.

Splitting into a separate service/repo was rejected: the integration is schema-coupled to
`user_role` / `role` / mappings, so a repo split reintroduces the #50 cross-tier type-drift
hazard. The isolation belongs at the module + queue seam, not a repo boundary.

## Decision

One image, a **`PROCESS_ROLE`** env toggle resolved into an injected `ProcessRole` provider
(generalising the existing `DISABLE_QUEUE` precedent):

- `api` → HTTP only (`NestFactory.create`); no queue consumers, cron, or Gateway.
- `worker` → application context (no HTTP); pg-boss consumers + cron + GC + the Gateway
  listener; holds the singletons.
- Every background starter guards on `ProcessRole`. The **Gateway socket is the load-bearing
  guard** (the only strict single-instance requirement; queue consumers/cron are once-only
  via pg-boss regardless, so their gating is operational hygiene, not correctness). A test
  asserts the `api` role opens no socket and schedules no cron.
- Dev / `docker compose` runs **one combined process**; prod splits into `api` (N replicas)
  + `worker` (1). Multi-instance worker leader election (advisory lock / pg-boss) is the
  deferred HA seam — designed, not built.

## Consequences

- **The split does *not* force the Postgres `LISTEN/NOTIFY` PubSub adapter** — contrary to
  the first framing of this decision. Every `PubSubPort` publisher is in the request tier
  (`tasks/submissions/messages`) and the SSE subscribe endpoint is in `api`, so publisher and
  subscriber both stay in `api` after the split and in-process pubsub keeps working. The
  worker tier publishes no SSE in v1 (integration changes emit admin-gated *activity*, not
  user notifications).
- `LISTEN/NOTIFY` is therefore **deferred**, guarded by a **pre-split assertion that no
  `PubSubPort.publish` runs in the worker role**. The day a worker-tier user notification is
  wanted, that adapter becomes a hard prerequisite of the prod split (it works in dev's
  combined process and would silently break in prod), and lands with a two-process test.
- The decrypt-only-in-worker property (ADR 0004) composes cleanly: the AEAD key is
  provisioned to the `worker` role only, so the internet-facing `api` tier holds neither the
  bot token nor the key.
