# ADR 0022 — Everyone, Member as a unit role, and default roles

- **Status:** Accepted
- **Date:** 2026-11-13
- **Refines:** ADR 0016 (seeded roles), ADR 0019 (unit roles), ADR 0021 (own)
- **Plan:** `docs/plans/member-unit-role.md`

## Context
Member was one org-wide role that invitations pre-assigned. Its rights over tasks
depended on membership through the `own_division`/`own_team` scopes. So a division
couldn't give its people different rights from another division's, and someone could
hold Member and belong nowhere. We wanted each division and team to decide what joining
it gives, while keeping that separate from membership itself: people in a unit can hold
different roles there.

## Decision
- **Everyone** is a new role kind, `baseline`, with exactly one role. Every user holds
  it without a `user_role` row: its grants project with an unconstrained principal, and
  the visibility pre-filter and admin floor count them for every user.
  - Its grants are edited in Permissions like any org role's.
  - The API refuses to give it, take it away, pre-assign it, map it from Discord, target
    it with a `role` grant, rename it or retire it (`409 BASELINE_ROLE`). These are plain
    API checks, not Cedar.
  - It isn't shown on people.
  - Seeded with: see people, roles, divisions, teams and request templates; see the tasks
    you're involved in, with their threads, submissions and files; leave a seat you hold.
- **Member is a unit role.** It is seeded once, assignable by leads, and holds `assigned`
  grants to see, discuss, claim and request the unit's tasks, plus `own` grants for
  your own work there.
- **Unit roles may use `own`**, projected per unit as "own, and in this unit".
- **Default roles.** Divisions and teams have a `default_role_id`, and new ones take the
  org setting (`system_settings.default_unit_role_id`, Member to start with).
  - Every path that adds a membership (the editor, assigning a unit role, Discord sync)
    gives the default role, marked `via_default`.
  - Every path that removes one (the editor, Discord sync, releasing an integration's
    grants) removes only the `via_default` assignments. Appointed roles stay.
  - Giving a default role needs only the right to manage members.
- **Changing a default** affects future joins. `POST /divisions/:id/members/default-role`
  (and the team route) gives it to current members on request.
- **Invitations** pre-assign no role.
- **Upgrade.** The bootstrap translates the org-wide Member, once:
  - org-wide reads and "involved" reads go to Everyone;
  - unit actions scoped org-wide, to divisions or to teams become `assigned`;
  - `own` grants stay `own`, now within the unit;
  - anything else is logged and dropped.

  Every unit then gets Member as its default, and every current member is given it. The
  old role is renamed "Member (before unit roles)" and retired with no holders.

## Consequences
What joining a unit gives is per unit and editable, and someone in no unit can still
read the directory and their own history but can't act. Assignments grow with
(members × units). Policies grow with (Member's grants × units), since they're projected
per unit, not per person. Removing someone from a unit removes their Member rights there
at once, but not a seat they already hold.
