# ADR 0009 — One typed event stream feeds the timeline and notifications

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
A task's history was senderless "system messages" whose bodies the client parsed with
regular expressions, notifications were emitted separately and could drift from it, and
system messages could be edited (problems R7, D27).

## Decision
- Commands record typed `domain_event` rows in their own transaction; payload schemas are
  defined once in Zod (`events/event.types.ts`) and exported in the contract.
- A task's events are its timeline (`GET /tasks/:id/timeline`).
- An event snapshots its notification recipients; delivery projects them into
  notifications after commit and again every minute, idempotently per (event,
  recipient).
- Messages are comments only. The org audit log (`activity`) stays a separate,
  configuration-focused record.

## Consequences
The timeline and notifications can't disagree, the client renders typed entries, and
delivery survives crashes. The migration converted existing system messages into
events.
