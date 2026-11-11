# Plan: Member becomes a unit role; divisions and teams get a default role

- **Status:** Implemented 2026-11-13 (ADR 0022). Decisions in §5. One change from §4.3: Everyone also holds "leave tasks · seated", so someone removed from a unit can still give up their seat.
- **Touches:** ADR 0007 (membership), 0016 (seeded roles), 0019 (unit roles), 0021 (own)

## 1. What we want

- **Member** becomes a **unit role**: held *at* a division or team, like Project lead.
- Every division and team may name a **default unit role**. Whenever someone joins a
  unit that has one, they're given that role there.
- **Holding a role isn't membership.** Membership says who is in the unit. Roles say
  what each person may do there, and members can hold different roles.
- The org-wide **Member** role goes away.

## 2. How it works today

| Piece | Today |
|---|---|
| Membership | A `membership` row (user × division or team) that grants nothing by itself. `own_division`/`own_team` scopes and claim restrictions read it. Five places write it: Admin › Users (single and batch), assigning a unit role, Discord sync, retiring an integration, and the user scrub. |
| Unit roles | `unit_role_assignment` (user × role × unit). Grants use one scope, `assigned`, and only actions on unit-shaped resources. Policies are projected **once per unit where the role is held**, not per person. A division assignment covers the division's single-division teams (ADR 0020). Assigning a role adds membership if it's missing; unassigning keeps the membership. **Removing a membership leaves the person's unit roles in place.** |
| Member (org) | Seeded once and pre-assigned by invitations (`system_settings.member_role_id`). It holds org-wide reads (people, roles, divisions, teams, request templates), `own` grants for tasks you're involved in, and `own_division`/`own_team` grants for seeing, commenting, claiming and requesting (ADR 0021). |
| Invitations | They can carry org roles only (`UNIT_ROLE_NOT_GRANTABLE`) and no memberships. |

## 3. Gaps the change runs into

**G1 — Member's grants that a unit role can't hold.** Unit roles only take unit
actions at `assigned`, so three groups of today's Member grants have no home:

- **Directory reads** (`user:read`, `role:read`). These aren't unit actions at all.
- **Structure reads** (`division:read`, `team:read`, request templates). You need to see
  divisions and teams you *aren't* in, for example to filter the board.
- **Personal rights:** see tasks you requested or hold a seat on, edit your own comments,
  submit, leave, and run tasks you requested. These follow you, not a unit.

**G2 — Where does someone in no unit stand?** A new invitee joins nothing, because
invitations can't carry memberships. With Member as a unit role, they'd hold no role at
all until an admin adds them somewhere.

**G3 — Removing a membership.** Should the role it brought go too? And if someone was
appointed Member by hand, should leaving the unit keep it?

**G4 — Changing a unit's default.** Does it apply only to future joins, or also to
people already there?

**G5 — Discord.** A membership synced from Discord should bring the default role too,
and take it away when the sync removes the membership.

**G6 — Who may cause an assignment.** Adding a member today needs `manage_members`.
Should a default-role assignment also need `assign_roles` and "assignable by leads"?

**G7 — Upgrading.** A role's kind is fixed at creation, so the org Member can't become a
unit role in place. Admins may also have edited Member's grants.

**G8 — Five places write memberships.** Each would need to add the default role.

## 4. Proposed design

### 4.1 Everyone: a hidden baseline role (fixes G1 and G2)

A new role kind, **`baseline`**, with exactly one role: **Everyone**.

- **Everyone holds it, structurally.** There are no `user_role` rows. Each principal's
  Cedar parents always include `Role::"<everyone>"`, and the visibility pre-filter counts
  its grants for every user.
- **Editable but not grantable.** Its grants show and edit in Admin › Permissions like
  any org role (org scopes, `own` included). The API refuses to give it, take it away,
  pre-assign it on an invitation, map it from Discord, or target it with a `role`-scoped
  grant (`409 BASELINE_ROLE`). It can't be renamed, retired or created a second time.
  These are plain API checks, not Cedar.
- **Not shown on people.** Users, invitations and role pickers never list it. The
  Permissions role list shows it in its own group, with a tooltip saying everyone signed
  in holds it.
- **Seeded grants:**
  - see people, roles, divisions, teams and request templates (`global`);
  - see the tasks you're involved in, with their threads, submissions and files
    (`own` = requested or seated).

  Nothing else, so nobody can *act* without a unit role, and someone who left a unit can
  still read their own history.
- **The admin floor:** Everyone's grants count towards it like any role's, so giving
  Everyone governance would make every user an admin. The editor warns about that.

### 4.2 Unit roles may use `own`, limited to their unit (fixes G1)

A unit role's `own` grant is projected per placement as "own **and** in this unit". So
Member at Writing can say "edit your own comments, submit on tasks you hold a seat on,
run tasks you requested", all in Writing. `assigned` keeps meaning "anything in the
unit". The editor offers both scopes for unit roles: "Where they hold this role" and
"Their own, where they hold this role".

### 4.3 Member, the unit role

Seeded once as a unit role named "Member", marked **assignable by leads**:

| Grants | Scope |
|---|---|
| See tasks, threads, submissions, files; post comments; claim; request tasks; see request templates | `assigned` |
| Leave, submit; edit and delete own comments; attach and delete own files; edit, retire, review, retire submissions, complete and manage claims on tasks you requested; edit a task's questions | `own` (in unit) |

### 4.4 A default role per unit (fixes G3, G4, G5, G6 and G8)

- `division.default_role_id` and `team.default_role_id`: nullable, a unit role, editable
  in Admin › Divisions and Teams. A setting, "Default role for new divisions and
  teams", defaults to Member and fills it in when a unit is created.
- `unit_role_assignment.via_default` (boolean) records that **joining** made the
  assignment, not an appointment.
- **One function joins a unit** (`MembershipService.join` / `leave`), and all five
  writers call it. Joining adds the membership and, if the unit has a default role, an
  assignment with `via_default`. Leaving removes the membership and **only** the
  `via_default` assignments at that unit; appointed roles stay, as ADR 0019 says.
- A default-role assignment needs only the right to add members (`manage_members`).
  Admins chose the default, so it isn't an appointment and skips "assignable by leads".
- **Changing a default** affects future joins only. The unit page offers an explicit
  "Give *Role* to the *n* current members who don't hold it" action, which records the
  new assignments as `via_default`.
- **Discord sync** joins and leaves through the same function, so synced members get
  the default role and lose it again on removal.

### 4.5 Upgrading an install (G7)

One migration plus a bootstrap step:

1. Create the unit role Member, translating the org Member's grants:
   - `own_division`/`own_team` → `assigned`;
   - `own` → `own` (in unit);
   - global reads, and `own` reads of tasks you're involved in, go to **Everyone**;
   - anything else is listed in the bootstrap log and left out.
2. Make Member the default of every active division and team, and of the new-unit setting.
3. Give Member, with `via_default`, at every existing membership.
4. Retire the org Member (it keeps its grants for the grace period, then GC collects
   it). Remove it from `system_settings` and from pending invitations.

### 4.6 What stays the same

- The `own_division`/`own_team` scopes on org roles stay, but nothing seeded uses them
  any more. We can retire them later if nothing does.
- The claim restriction stays a membership rule (ADR 0021).
- Policy count grows by about (Member's grants × units): roughly 25 × 16 in the demo.
  It's projected per unit, not per person.

## 5. Open questions for you

Settled 2026-11-12:

1. **Baseline:** a hidden, editable, ungrantable org-like role every user holds
   (Everyone, §4.1), not static policies.
2. **Own in unit roles:** yes (§4.2).
3. **Leaving a unit:** removes only the roles that joining gave.
4. **Changing a default:** future joins, plus an explicit "give it to current members"
   action.
5. **Invitations:** yes, as a follow-up. An invitation may name divisions and teams to
   join, so new people arrive with those units' default roles.

## 6. Suborganizations (exploratory, not part of this change)

**The idea:** divisions and teams become one thing, a **unit**, with a hierarchy, and
grants made higher up apply lower down, never upward.

**What supports it**

- Cedar already models this: entities have parents, and `resource in Unit::"X"` is
  transitive. Today we hand-roll the division-to-team reach with `singleDivisionTeamIn`
  and the `assigned` projection, so a real hierarchy would delete code.
- Default roles, membership, unit roles, stats and restrict-claims are already the same
  for divisions and teams. A single `unit` table would remove the duplicate paths
  (`unitWhere(kind, …)`, `ASSIGN_ACTION[unitType]`, two default-role columns).

**What makes it hard**

- **Several parents.** A team serving Writing and Art (ADR 0020) would sit under two
  parents. "Grants flow down" would then let a Writing lead run that team, which ADR
  0020 decided against. We'd have to choose:
  - parents' authority reaches only children with a single parent (today's rule,
    generalised), or
  - the hierarchy is a tree, and "serves several divisions" becomes a different relation
    from "is under".
- **Tasks sit in two places.** A task belongs to a division *and* optionally a team, and
  the division drives templates, seats and custom questions. In a hierarchy, a task
  would belong to one unit and inherit settings from its ancestors. That rewrites
  templates and settings lookup, the task board filters and the stats.
- **Discord mappings, routes, the contract and the web** all name divisions and teams
  separately.

**Suggestion:** build the Member shift on unit-neutral pieces: the join/leave function,
a default role "per unit", and `via_default`. Then a later move to suborganizations
replaces the two unit kinds without touching this work. The "several parents" question
needs settling first; it deserves its own plan and a grilling session.
