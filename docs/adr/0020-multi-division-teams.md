# ADR 0020 — Teams that serve several divisions

- **Status:** Accepted
- **Date:** 2026-11-11
- **Refines:** ADR 0019 (unit roles)

## Context
A team belonged to exactly one division, so a country team doing both Writing and Art
had to exist twice ("United States — Writing", "United States — Art"), with its people
and leads split between the copies. The plan is in `docs/plans/multi-division-teams.md`.

## Decision
- A team **supports** a set of divisions: a list (`team_division`, at least one), or
  **all divisions** (`team.all_divisions`, which includes divisions created later). A
  task still has one division and at most one team, and the team must support the
  division (`422 TEAM_NOT_IN_DIVISION`).
- **Division authority reaches a team only while it supports exactly that one
  division.** This applies to unit roles assigned at a division and to division-scoped
  grants (`specific_division`, `own_division`). A team serving several divisions, or all
  of them, is run by org-wide grants and by roles held at the team itself. ADR 0019's "a
  division assignment covers its teams" now reads "covers its single-division teams".
- The rule lives in the policies. Cedar always gets the team's true attributes
  (`divisions`, `allDivisions`, and `divisionCount`, since Cedar has no set size); nothing
  is left out of an entity to make a policy miss.
- **Team actions are division- and team-scopable** (Team joined the group-scopable
  resources). `team:create` is asserted on the proposed team, built from the requested
  divisions, so a division-scoped `team:create` grant keeps its old meaning: it permits
  teams that serve that division alone. `team:update` that changes the division set is
  checked on the team as it is and as it would be, so nobody can widen a team beyond
  their reach, or take over a wider team by narrowing it.
  - *Rejected:* keeping team actions `global`/`assigned` only, with `team:create` on the
    Division. It left division authority over teams with unit roles alone, and a
    multi-division team could only be created with a global grant checked outside Cedar.
- **Guards.** Dropping a division a team's tasks use is refused
  (`409 TEAM_DIVISION_IN_USE`, with counts); retired tasks count too. Retiring a division
  is refused while any active team would be left with no active division
  (`409 DIVISION_SOLE_TEAM_DIVISION`, naming the teams). **This includes single-division
  teams**, whose division used to retire freely: retire or widen the team first.

## Consequences
One team per real group, wherever its work lands. Admins can now grant team actions per
division or per team. A team's division list can in practice only grow once it has tasks
(no way yet to move a task to another team or division). Release notes must call out
that a division with an active single-division team no longer retires until the team is
retired.
