# ADR 0008 — Completion is a recorded, terminal fact

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
Manual completion wrote `approved` into `status_cache` and nothing else, so the next
recompute undid it (problems R4, D5); creation used a different status function from every
other path.

## Decision
- `task.completed_at` and `completed_by` record completion. It is terminal: there is no
  reopen. Completing closes claims and marks outstanding submissions `not_required`.
- One pure function, `deriveStatus`, derives status from the completion fact, openings,
  claims-closed and each seat's current-tenure submission. Every path uses it, creation
  included.
- `status_cache` is never null and is only a stored copy; `TaskStatusService.rebuild`
  recomputes it from facts and reports drift.

## Consequences
Status can't be silently undone, and the list filter can be trusted. If reopening is ever
needed it will be a separate `task:reopen` action that clears the fact and records an
event.
