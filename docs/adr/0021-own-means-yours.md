# ADR 0021 — "Own" means yours; claim restrictions are a rule

- **Status:** Accepted
- **Date:** 2026-11-12
- **Refines:** ADR 0016 (seeded roles)

## Context
`own` on reading a task, its thread, submissions and files, and on commenting, meant
"requested it, holds a seat, or could claim it". "Could claim it" only failed where a
division or team restricted claims, and none did by default. So the seeded Member role
let a brand-new user who belonged to nothing open, read and comment on every task in
the organisation. The permission editor hid this: it showed these grants as "Own",
explained as "only tasks the person owns".

## Decision
- `own` on `task:read`, `message:read`, `submission:read`, `attachment:read` and
  `message:create` means **involved**: requested the task or holds a seat on it.
- Claiming (`task:assign`) has no `own` scope. It is about tasks that aren't yours yet,
  so it is scoped by division, team, unit-role assignment or org-wide.
- **Restricting claims is a static forbid** (`static_claim_restriction`): a non-member
  can't claim a task in a division or team that restricts claims, whatever grant would
  permit it. Putting someone on a task isn't a claim and isn't restricted.
- Member is seeded with the involved grants plus `own_division` and `own_team` grants
  for seeing, commenting and claiming. Someone in no division or team sees only the
  tasks they requested or work on.
- The migration keeps each role's reach inside its holders' units: every `own` permit
  on those actions gains `own_division` and `own_team` siblings, and `task:assign` at
  `own` becomes those two.

## Consequences
Visibility follows membership, and the editor can say plainly what each scope does.
Roles with an `own` read grant lose sight of open tasks outside their holders' units;
that is the point. An org-wide claim grant no longer gets past a unit's claim
restriction.
