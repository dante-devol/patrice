# ADR 0019 — Unit roles: roles held at a division or team

- **Status:** Accepted
- **Date:** 2026-11-06
- **Refines:** ADR 0007 (membership is not authority)

## Context
Leads need authority over their own division or team only. The available scopes couldn't
express "Maya leads Writing": `own_division` follows membership, so a lead who also
belongs to Art would lead Art too. `specific_division` needs one role per unit, which
multiplies roles and still can't say who leads where. The plan is in
`docs/plans/projects-and-unit-roles.md`.

## Decision
- A role has a **kind**, fixed at creation. **Org roles** work as before. **Unit roles**
  are assigned to a person *at* a division or team (`unit_role_assignment`), never
  granted org-wide.
- A unit role's grants use one scope, **`assigned`**, and only actions on unit-shaped
  resources (tasks, messages, attachments, divisions, teams). The API refuses
  Organization actions and other scopes (`422 UNIT_ROLE_SCOPE`), and org roles can't use
  `assigned`. Unit roles therefore can't hold governance, so the admin floor doesn't
  change.
- Cedar: a holder's principal is `in UnitRole::"<role>@<unit>"` for each assignment. Each
  `assigned` grant is projected once per unit where its role is assigned, with a
  condition on the resource's division or team. **A division assignment covers its
  teams.** Assignments change the policy set, so assigning and unassigning bump
  `config_version`.
- **Assigning** needs `division:assign_roles` / `team:assign_roles` on the unit. Through a
  unit role, that permit also requires the target role to be **assignable by leads**.
  Admins, through org grants, can assign any unit role. Assigning adds membership if
  missing; unassigning keeps it.
- Seeded once: **Project lead**, an unassigned unit role that is not assignable by leads.
  Its grants run the unit's work and shape the unit.
- Unit stats (`/divisions/:id/stats`, `/teams/:id/stats`) count only the tasks the caller
  can see.

## Consequences
"Leads Writing" is a single row, and the same role works for every unit. Policy count
grows with (assigned grants × units holding the role), which is small at this org's size.
Discord mappings to unit roles are out of scope for now.
