# ADR 0016 — Seeded Admin and Member roles

- **Status:** Accepted
- **Date:** 2026-11-04

## Context
A fresh install could do no work: Admin held only governance and config actions, and no
role existed for ordinary members (problems D29).

## Decision
- Admin holds every action at global scope and is topped up whenever actions are added.
- Member is seeded once with starter grants (read structure and names; see, claim, work
  on and request tasks in your divisions) and pre-assigned to new invitations. It is the
  admins' to edit.
  *(ADR 0021 narrows "your divisions" to the divisions and teams you belong to, plus tasks you
  requested or work on. ADR 0022 replaces the org-wide Member with Everyone and a Member
  unit role, and invitations no longer pre-assign a role.)*
- Upgrading an install from before Member existed adopts an existing "Member" role and
  gives Member to every active user, because reads used to need no grant (found by the
  cutover rehearsal).

## Consequences
A fresh install and an upgraded one both work immediately.
