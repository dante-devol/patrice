# ADR 0013 — What happens to grants an integration made

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** ADR 0002 (Patrice side) (in `docs/old/adr/`)

## Context
Deleting a mapping stranded the roles it granted, labelled as integration-sourced forever
(problems D23); Discord could only map roles; a role mapped inbound could later be given
governance actions (D4).

## Decision
- A mapping targets a role, a division membership or a team membership.
- Deleting a mapping shows how many grants it made; the admin keeps them as native grants
  (the default) or revokes them. Grants still made by another mapping on the connection
  are left alone.
- Retiring a connection pauses sync and records the same choice, applied when the
  connection is collected after grace; revive cancels it. Reconnecting a retired guild
  revives its connection.
- Revocations run under the admin floor. Governance roles can't be mapped, and a role
  mapped inbound or bidirectionally can't be given a governance permit.

## Consequences
Nothing is left half-owned. ADR 0002's "orphan, never reclaim" still governs the Discord
side.
