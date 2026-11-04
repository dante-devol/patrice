# ADR 0017 — API and worker are separate root modules

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** ADR 0003 (in `docs/old/adr/`)

## Context
`PROCESS_ROLE` was checked by each module for itself, and several didn't, so the API ran
GC and email consumers; failed enqueues were logged and dropped; some consumers had no
schedule (problems R2, R8, D21).

## Decision
- `ApiModule` (HTTP) and `WorkerModule` (jobs, schedules, email, bootstrap mode, token
  vault, sync engine, Gateway) share `CoreModule`; no module checks the role. The API
  publishes but never consumes.
- Every queue has a retry policy and, unless its data must not be copied, a dead-letter
  queue admins can list. Publishing fails with `503 QUEUE_UNAVAILABLE` and `/health`
  reports `degraded` when pg-boss is down.
- Admin changes to a connection reach the worker as jobs, so Gateway sessions follow
  without a restart.
- Tests run pg-boss in sync mode.

## Consequences
What a process runs is what its root module imports, and a test asserts it. Run one worker;
multi-worker leader election remains a future seam.
