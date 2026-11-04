# ADR 0014 — Undo scope: what retires and what is deleted

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
Every entity type had retire/revive, which made messages, attachments and grants
expensive to reason about and left editable "retired" rows (intent-vs-reality §6.4).

## Decision
- Retire → grace → revive → GC: tasks, users, divisions, teams, roles, integration
  connections.
- Deleted outright with an audit row: grants, messages (kept as an empty marker while
  replies exist), attachments, library templates.
- Retired tasks stay readable (thread and timeline) during grace.
- GC deletes history-less users and scrubs history-bearing ones in place, Discord
  identities included.

## Consequences
Undo exists where losing the thing would hurt; everything else is simpler and audited.
