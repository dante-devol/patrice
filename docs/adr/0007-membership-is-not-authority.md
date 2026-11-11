# ADR 0007 — Membership is not authority; teams belong to divisions

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
Belonging to a division or team was represented only by holding its auto-created
"inherent role", so membership always brought that role's grants with it, Discord could
only map roles, and retiring a unit could retire an admin (problems R5, D2). Teams were
unrelated to divisions, so scopes couldn't inherit.

## Decision
- Membership is its own `membership` row (user × division, or user × team) and grants
  nothing by itself. Authority comes only from roles and their grants.
- Every team belongs to exactly one division; a task's team must be in its division.
  *(Superseded by ADR 0020: a team supports one division, several, or all of them.)*
  Division membership isn't implied by team membership: both are explicit rows.
- Cedar parents run team → division, so a division-scoped grant covers its teams' tasks;
  `own_division` and `own_team` scopes read the principal's memberships.
- Inherent roles are gone; the migration turned their holders into memberships.

## Consequences
Scopes are predictable and Discord can map memberships (ADR 0013). Retiring a unit can't
touch authority. Admins grant division authority explicitly, which is a few more clicks
than an inherent role gave them.
