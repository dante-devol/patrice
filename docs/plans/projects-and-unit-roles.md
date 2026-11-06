# Plan: division and team pages, and unit roles

Backlog items 1 and 2: a **page for each division and team** (stats, members,
leadership, tasks) with home-page cards, and a way to make someone an admin **for** a
specific division or team. Item 2 comes first, because the pages' "leadership" section
is built on it. Decisions were settled with the owner on 2026-11-06 (§6).

## 1. The problem with today's model

Authority comes only from roles and their grants (ADR 0007). To make Maya "lead of
Writing" today, an admin has two options, and neither fits:

| Option | Problem |
|---|---|
| A role with grants scoped `specific_division: Writing` | One role per unit ("Writing lead", "Art lead", …), each with its own copy of the grants |
| A role with grants scoped `own_division` | Authority follows **every** unit the holder is a member of. A lead of Writing who is also a member of Art becomes a lead of Art. |

What's needed is the usual "role assignment at a scope": **one "Project lead" role,
assigned to Maya *at Writing***. Her lead grants apply in Writing only, whatever else she
belongs to. An overall admin who is a member of Art isn't Art's lead unless assigned there.

## 2. Unit roles (item 2)

### 2.1 Model

| Change | Detail |
|---|---|
| `role.kind`: `org` (today's roles, the default) or `unit` | Fixed at creation. A unit role is only ever **assigned at a unit**; an org role is never assigned at a unit. |
| `role.assignable_by_leads` (unit roles only, default false) | Whether someone whose appointing power comes from a unit role may assign this role (§2.2). |
| New table `unit_role_assignment` | `id`, `user_id`, `role_id`, `division_id` *or* `team_id` (CHECK exactly one), `granted_by`, `created_at`. Unique per (user, role, unit). FK cascades on unit, role and user removal. |
| New scope kind `assigned` | "Wherever this role is assigned." The **only** scope a unit role's grants take. |
| Unit-role grants are limited to unit-shaped actions | Actions whose resource is a Task, Message, Attachment, Division or Team. Organization-level actions (grants, roles, users, config, integrations) can't be granted to a unit role. |
| New actions `division:assign_roles`, `team:assign_roles` | Assign or unassign unit roles at that unit. |

Rules:

- **A division assignment covers its teams**; a team assignment covers that team only.
- **Assigning adds membership.** If the person isn't already a member of the unit, the
  assignment adds them in the same transaction (audited as `membership.added`).
  Unassigning leaves the membership in place.
- A separate table keeps every existing `user_role` path (effective admins, visibility,
  sync) untouched.

### 2.2 Cedar

This fits the existing projector, which already emits one policy per grant with concrete
ids:

- The principal gains parents `UnitRole::"<roleId>@division:<id>"` (or `@team:<id>`) for
  each of its assignments. It is **not** `in Role::"<roleId>"` for a unit role, so nothing
  leaks org-wide.
- For each grant on a unit role R, and each unit where R is assigned to anyone, the
  projector emits:

  ```cedar
  permit(principal in Patrice::UnitRole::"R@division:D", action == …, resource)
  when { resource has division && resource.division == Patrice::Division::"D" };
  ```

  (or `resource.team == Team::"T"` for a team assignment). That's one policy per (grant ×
  unit where the role is used), not per user.
- **Leads may only appoint flagged roles.** The resource for `*:assign_roles` carries the
  role being assigned (`targetRole`) and its `assignableByLeads` flag. When the
  `assign_roles` grant sits on a **unit role**, the projector adds
  `&& resource.targetRoleAssignableByLeads` to the policy. On an **org role** (an admin's)
  it doesn't, so admins can assign any unit role.
- Assigning or unassigning bumps `config_version` (it's an authority change), so the cached
  policy set is rebuilt. It goes through the `UnitOfWork` like any other authority change.
- `VisibilityService.taskWhere` (the list pre-filter) adds: `divisionId`/`teamId` in the
  units where the caller holds a unit role with an `assigned` `task:read` grant.
- `allowedActions`, forbids, the Discord gate and the self-review forbid all apply
  unchanged.

**Admin floor:** unit roles can't hold Organization-level actions, so they can never make
or unmake an effective admin. The floor needs no change, and a test pins that down.

### 2.3 API

| Endpoint | Action | Notes |
|---|---|---|
| `GET /divisions/:id/role-assignments`, `GET /teams/:id/role-assignments` | `division:read` / `team:read` | Who holds which unit role there. Feeds "leadership". |
| `POST /divisions/:id/role-assignments` `{ userId, roleId }` | `division:assign_roles` (on the division, with `targetRole`) | 422 if the role isn't a unit role or the user is retired. Adds membership if missing. |
| `DELETE /divisions/:id/role-assignments/:assignmentId` | `division:assign_roles` | Membership stays |
| …the same for teams | `team:assign_roles` | |
| `GET /me/memberships` | (self) | The caller's memberships and unit-role assignments, with unit names. Feeds the home page. |
| Roles and grants | as today | `role.kind` on create (immutable); `assignableByLeads` editable on unit roles. The grant validator enforces the unit-role rules; `GET /actions` reports `assigned` as a scope for unit-shaped actions. |

Audit: `unit_role.assigned` / `unit_role.unassigned` `{ userId, roleId, unitType, unitId }`,
and `role.updated` changes include `assignableByLeads`. The assignee gets a notification
("You're now Project lead in Writing").

### 2.4 Seeding

Seed one editable unit role, **Project lead**, unassigned and **not** assignable by
leads. Its starter grants, all `assigned`:

- `task:*` except `task:bypass_discord_gate`;
- `message:update`, `message:delete`, `attachment:delete`;
- `division:update`, `division:manage_members`;
- `team:create`, `team:update`, `team:manage_members`;
- `request_template:*`;
- `division:assign_roles`, `team:assign_roles`.

Only admins can appoint Project leads. Leads can appoint any unit roles an admin later
flags as assignable by leads (e.g. a "Reviewer" role).

## 3. Division and team pages (item 1)

### 3.1 API

| Endpoint | Notes |
|---|---|
| `GET /divisions/:id/stats`, `GET /teams/:id/stats` `?from&to` | Computed over the tasks **the caller can see** in that unit (the same pre-filter plus per-row Cedar check as `GET /tasks`), so stats never leak hidden work. Anyone who can read the unit can call it. Division stats include its teams. |

Stats payload (first cut):

- counts by status, plus completed and retired;
- weekly series: created, completed (`completed_at`);
- median days from creation to completion;
- age of open and claimed tasks (median, oldest);
- median review turnaround (`submitted_at` → `reviewed_at`);
- per team (division page only): open and completed counts.

Members (`/…/members`, exists) and leadership (`/…/role-assignments`, §2.3) come from their
own endpoints.

### 3.2 Web

- **Division page** `/divisions/:id` and **team page** `/teams/:id`:
  - header with name, parent division (for a team) and its teams (for a division);
  - stats strip and two small charts: created vs completed per week, and median times;
  - **Leadership**: unit-role holders, grouped by role. Assign and unassign controls
    appear when `allowedActions` on the unit includes `*:assign_roles`; the role picker
    lists only roles the caller may assign.
  - **Members**: the member list;
  - **Tasks**: the existing task list, pre-filtered to the unit. `TaskListComponent` gets
    preset-filter inputs instead of a second copy.
- **Home page**:
  - **Your divisions and teams**: a card per unit the caller belongs to or leads (from
    `/me/memberships`), with open and "your claimed" counts, linking to the unit's page.
  - **Your Work**: claimed tasks grouped under those cards. A task goes under its team if
    the caller is in that team, else under its division, else under "Other".
- **Roles admin**: an "Org role / Unit role" choice when creating a role, and an
  "Assignable by leads" toggle on unit roles. The permissions editor offers only
  `assigned` for unit roles. Keep these edits small, because the admin-workflow branch is
  reworking these tabs (see §5).

## 4. Phases

1. **Unit roles, API.** Migration (`role.kind`, `assignable_by_leads`,
   `unit_role_assignment`, scope `assigned`, the two actions), projector and Cedar schema,
   visibility pre-filter, grant validation, assignment endpoints (adding membership),
   `/me/memberships`, audit and notification, the seeded Project lead, contract.
   Done when e2e tests cover:
   - a lead assigned at Writing can review Writing tasks but not Art tasks, even as a
     member of Art;
   - a division assignment covers its teams; a team assignment covers only that team;
   - assigning adds membership and unassigning keeps it;
   - a lead can assign a flagged unit role but not an unflagged one (e.g. Project lead),
     while an admin can assign either;
   - a forbid on a unit role applies;
   - a unit role refuses Organization actions and non-`assigned` scopes;
   - assignment changes take effect immediately (`config_version`);
   - the admin floor is untouched.
2. **Unit stats, API.** Stats endpoints, with e2e coverage that stats only count tasks the
   caller can see.
3. **Web.** Division and team pages, home cards and grouped Your Work, leadership
   management, and the small roles and permissions admin changes.
4. **Docs.** ADR 0019 (unit roles), and updates to `docs/architecture.md` §4 and the
   glossary (Unit role, Unit role assignment, Assignable by leads).

Phases 1 and 2 are independent and can run in parallel. Phase 3 needs both.

## 5. Coordination

The admin-workflow branch (`docs/briefs/admin-workflow.md`) is reworking Admin > Users,
adding a batch membership endpoint, and adding save/cancel across admin tabs, including
roles and permissions.

- Leadership is managed on the **division and team pages**, not in Admin > Users, so the
  two don't collide.
- Land the Phase 3 changes to the roles and permissions editors **after** that branch
  merges, or keep them to the scope picker, the role-kind field and the lead-assignable
  toggle.
- If their batch membership endpoint lands first, the page's member controls should use it.

## 6. Decisions (settled 2026-11-06)

| # | Question | Decision |
|---|---|---|
| 1 | A new UI word ("Project") for divisions and teams? | **No.** Keep "division" and "team" everywhere; the pages are the division page and the team page. |
| 2 | Unit roles as a separate role kind, or any role assignable at a unit? | **A separate kind** (`org` or `unit`, fixed at creation) |
| 3 | Does assigning a unit role require, or add, membership? | **It adds membership** if missing; unassigning keeps it |
| 4 | Can a lead hand out any unit role in their unit? | **Only roles flagged "assignable by leads".** Admins (via org roles) can assign any unit role. |
| 5 | Does a division assignment cover its teams? | **Yes** |
| 6 | Who sees a unit's stats? | **Anyone**, computed only over the tasks they can see |
| 7 | Seed a "Project lead" unit role? | **Yes**, editable, unassigned, not assignable by leads |
| 8 | Discord mappings to unit roles | **Out of scope**; revisit with integrations planning |
