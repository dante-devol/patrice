# Plan: teams that serve more than one division

**Status:** implemented 2026-11-11 (ADR 0020). §3.1's known gap remains open.

Today a team belongs to exactly one division (`team.division_id`). This plan lets a
team **support a set of divisions** (one, several, or all), so a "USA" team can take
Writing and Art requests and hold members from both. Decisions were settled with the
owner on 2026-11-10 (§7). Revised on 2026-11-11 after a review against the code, which
found that §2's authority rules didn't match how team grants work. The owner chose
option A (team actions become division- and team-scopable) and kept the retire block
for single-division teams on 2026-11-11; nothing is left open.

## 1. The model

| Change | Detail |
|---|---|
| New table `team_division` | `team_id`, `division_id`, PK on both. FK cascades on team removal, restricts on division removal. |
| New column `team.all_divisions` (bool, default false) | True: the team supports every division, including ones created later. False: it supports exactly its `team_division` rows (at least one). |
| Drop `team.division_id` | The migration first writes one `team_division` row per existing team, so every current team behaves as before. |

A team always supports at least one division: `all_divisions`, or at least one row.
The API enforces this; a deferred CHECK isn't worth it. Team names have no uniqueness
constraint tied to the division, so dropping the column loses nothing there.

A task still has exactly one division and at most one team. The task-creation rule
`TEAM_NOT_IN_DIVISION` becomes "the team supports this division"
(`all_divisions || row exists`). Membership is unchanged: team membership was already
independent of division membership (ADR 0007).

## 2. Authority (Cedar)

**Owner decision:** a multi-division or all-division team is administered only by
org-wide authority and by roles held *at the team*. Division authority reaches a team
only when the team has exactly one division.

**The rule lives in the policies; the entities only state facts.** Cedar is always sent
the whole truth about a team. Nothing is left out to make a policy miss.

### 2.1 How division authority reaches a team today

Today, grant scopes are limited by resource type. `grants.service.ts` allows division
and team scopes (`specific_division`, `own_division`, `specific_team`, `own_team`) only
on actions whose resource is a Task, Message, Attachment or Division
(`GROUP_SCOPABLE`). So:

- **Team actions** (`team:update`, `:retire`, `:revive`, `:manage_members`,
  `:assign_roles`) can only be granted `global`, or `assigned` for a unit role.
- **`team:create`** targets a Division, so it can be granted per division.
- **The only way a division's authority reaches its teams** is a unit role assigned at
  the division: `grantToPolicies` projects it as
  `resource has division && resource.division == D`, which matches a Team through its
  `division` attribute. That's how the seeded Project lead runs a division's teams
  (`team:create`, `team:update`, `team:manage_members`, `team:assign_roles`, all
  `assigned`).

### 2.2 The Team entity

| Attribute | Value |
|---|---|
| `team` | Itself (as today). |
| `divisions: Set<Division>` | The divisions it lists. Empty when `allDivisions`. |
| `allDivisions: Bool` | The `team.all_divisions` column. |
| `divisionCount: Long` | `divisions`' size, sent because Cedar has no set-size operator. |
| `restrictClaims`, `targetRole…` | As today. |

The old `division` attribute is removed from `Team`. The Division, Task, Message and
Attachment entities are unchanged. The Cedar schema (used only to validate policies
when they're rebuilt; requests are checked without it) gains `divisions?`,
`allDivisions?` and `divisionCount?` on `Team`.

**Every place that builds a Team entity** must send these: `EntityLoader.team`,
`teamRef()` and its callers, including `MembershipService.loadUnits` (which builds the
units Admin › Users can edit). A caller that still sends only `division` would silently
give the old answer.

### 2.3 The unit-role clause (the one that matters)

In `grantToPolicies`, a unit role assigned at division D gains a team branch next to
today's `resource has division` branch, which still serves divisions and tasks:

```cedar
// a unit role assigned at division D
(resource has division && resource.division == D)
|| (resource has divisions && !resource.allDivisions
    && resource.divisionCount == 1 && resource.divisions.contains(D))
```

A Writing lead therefore keeps running USA[Writing], and loses USA[Writing, Art] and
USA[all], on the teams' true attributes. That's the policy deciding, not missing data.
`policies.spec.ts` covers it against those three teams, and e2e tests do the same
through the Project lead.

### 2.4 The division-scope clauses (option A, settled)

Team actions become division-scopable, so `specific_division` and `own_division` need
the same team branch. (Option B, rejected, would have kept team actions `global` or
`assigned` only and left `scopeCondition` alone.)

- **Option A:**
  - **What changes:** add `Team` to `GROUP_SCOPABLE`, so team actions can be granted
    per division or per team, like task actions.
  - **The new branches:** `scopeCondition` gets the same team branch for both scopes:

    ```cedar
    // specific_division D
    (resource has division && resource.division == D)
    || (resource has divisions && !resource.allDivisions
        && resource.divisionCount == 1 && resource.divisions.contains(D))

    // own_division
    (resource has division && principal.memberDivisions.contains(resource.division))
    || (resource has divisions && !resource.allDivisions
        && resource.divisionCount == 1 && principal.memberDivisions.containsAll(resource.divisions))
    ```

  - **Team scopes:** `specific_team` and `own_team` already match a Team through its
    self-reference.
  - **Effect on today's grants:** this widens what admins *can* grant. It changes no
    existing grant, since none can hold these scopes on team actions today.

### 2.5 Creating and changing a team

| Action | Rule |
|---|---|
| `team:create` | Asserted on **the proposed team** (`resourceType: 'Team'`). The service generates the new team's id up front, builds its entity from the requested divisions, asks Cedar, then inserts that same team. Existing division-scoped `team:create` grants keep their meaning (they now permit single-division teams in that division), because Team is scopable. |
| `team:update` changing the division set | Asserted on the team **as it is and as it would be**. A Writing lead can't widen USA to Art, and can't take over a multi-division team by narrowing it. |
| `team:read`, `:retire`, `:revive`, `:manage_members`, `:assign_roles` | No service change; the clauses decide. |
| Task, Message, Attachment actions | Unchanged: they carry the task's own division and team. |

ADR 0019's "a division assignment covers its teams" becomes "covers its single-division
teams". Record this as a new ADR (0020), including the option A decision (and why B
was rejected) and the retire block (§7.1 item 6). Update the glossary
entries for **Team**, and the Team → Division relationship, in `UBIQUITOUS_LANGUAGE.md`.

## 3. Guards

| Situation | Behaviour |
|---|---|
| Removing a division from a team (or switching off `all_divisions`) while the team has tasks in a division it would no longer support | `409 TEAM_DIVISION_IN_USE`, with the count per division. Retired tasks count too (see §3.1). |
| Retiring a division would leave some team with no **active** division (not `all_divisions`, and every other division it lists is already retired) | `409 DIVISION_SOLE_TEAM_DIVISION`, naming the teams. Teams with another active division, and all-division teams, don't block. **This is new for today's single-division teams too** (§7.1 item 6; note it in the release notes). |
| A team listing a retired division | Allowed (it still has others). The task form offers active divisions only. |
| GC of a division | `divisionCollectable` counts `team_division` rows instead of `team.division_id`. |

### 3.1 Known gap: a team's tasks pin its divisions

Once a team has a task in a division, that division can't be removed from the team, and
retired tasks keep it pinned too. Nothing lets an admin move those tasks to another
team or division, or lets old tasks keep a pairing the team no longer offers. So in
practice a team's division list can only grow. This is accepted for now. Options to
revisit: let a task keep a pairing the team has since dropped (and mark it as such), or
add a "move tasks" step to the narrowing flow.

## 4. API

- **`TeamView`:** `divisionId` → `divisionIds: string[]` and `allDivisions: boolean`.
- **`POST /teams`, `PATCH /teams/:id`:** accept `divisionIds` (at least one) or
  `allDivisions: true`.
- **"My units"** (`unit-roles.service.ts`, `MyUnit`): a team's `divisionId` becomes
  `divisionIds` and `allDivisions`. It feeds Home's "Team in X".
- **Division stats** (`unit-stats.service.ts`): a division's `teams` list includes every
  team that supports it (all-division teams too), not just `team.division_id = D`. Each
  team's numbers there count only that division's tasks. A `team` filter on a division's
  stats accepts those teams.
- **Generated contract:** OpenAPI, `schema.d.ts` and `web/src/app/core/api.types.ts`
  follow (`npm run contract:emit`).
- **Unaffected:**
  - Integrations: a mapping to a team grants team membership only.
  - The activity log: `team.created` records only the team's id, and `team.updated`'s
    list of changed fields simply gains "divisions".
  - Task visibility: `visibility.service.ts` filters by the task's own division.

## 5. Web

**Task creation** (`task-list.component.ts`): each dropdown lists only options valid
with the other's current choice; nothing invalid is ever shown.
- **Division list:** the divisions you can request in, narrowed to the chosen team's.
- **Team list:** "No team", plus teams that support the chosen division (all-division
  teams included). With no division chosen, every team.
- **Auto-pick:** if the chosen team leaves exactly one division, it's picked, since the
  template library needs a division.
- **Embedded on a team page:** the team is preset, and the division picker shows its
  divisions.

**Division page** (`unit-page.component.ts`, `unit-filter.component.ts`):
- **Which teams:** `childTeams` becomes the teams that support the division, from the
  stats response or `supports()`, not `t.divisionId === id`.
- **Where it shows:** the Teams section, the status chart's team checkboxes, and the
  embedded task list's team filter.

**Team page** (`unit-page.component.ts`): "Team in X" becomes the division list (or
"all divisions"). The embedded task list drops its division preset and filters by team
only.

**Admin › Users** (`users-admin.component.ts`): the left list becomes
- **Overall**
- **Divisions:** each division, with every team that supports it nested under it. A
  nested team's count is the people who are members of **both** that division and that
  team.
- **Teams:** a flat list of every team, with its plain membership count.

Clicking a team, nested or in the flat list, selects the team itself: the same pane,
count and member editing, with no division context. The header reads
"Team · Writing, Art" (or "Team · all divisions") instead of "Team in X". Selection
highlighting is by team, so every row for that team highlights together.

**Elsewhere**
- **`teams-admin`:** the division picker becomes a multi-select with an "All
  divisions" option, and the column lists the divisions.
- **`home.component.ts`:** the cards, and the task list's team filter, match on
  "supports" instead of `t.divisionId ===`.
- **Unchanged:** task rows and the task detail use the task's own division.
- **`permissions-admin`:** team actions gain the division and team scopes in the
  editor automatically (it reads the action catalog).

A shared `supports(team, divisionId)` helper (in `lookup.store.ts`) keeps these
consistent.

## 6. Seed

The demo seed already has one team per country per division ("United States —
Writing", "United States — Coding", …), which is exactly the motivating case. Rather
than adding one example multi-division team, merge each country's teams into one
multi-division team ("United States" for Writing and Coding), and keep one
single-division and one all-division team so all three shapes appear in the demo.
The seed also writes `demo/personas.json`; check that its descriptions still match.

## 7. Decisions

### 7.1 Settled (owner, 2026-11-10 and 2026-11-11)

1. **Who administers a multi-division team:** org-wide authority and team-held roles
   only. Division authority doesn't reach it.
2. **Shrinking a team's divisions while tasks use a removed one:** blocked.
3. **"All divisions"** includes divisions created later. Retiring a division that a
   team depends on alone is **blocked**.
4. **Admin › Users** gets a flat Teams list after Divisions, and teams also appear under
   every division they support.
5. **Team actions become division- and team-scopable** (option A, §2.4; owner,
   2026-11-11). `Team` joins `GROUP_SCOPABLE`, and `team:create` is asserted on the
   proposed team (§2.5). Admins can now grant team actions per division or per team;
   no existing grant changes. Option B (unit roles alone carry division authority to
   teams, `team:create` stays on Division) was rejected.
6. **The retire block applies to single-division teams too** (owner, 2026-11-11).
   Retiring a division is refused while any active team would be left with no active
   division, including today's single-division teams: retiring Writing is refused while
   "United States — Writing" is active, where today it succeeds. Retire (or widen) the
   team first. Call this out in the release notes.

## 8. Order of work

1. **Data and API:**
   - migration, Prisma model, `TeamView`, `MyUnit`;
   - the create, update and retire guards, and the task-creation rule;
   - division stats listing supporting teams.
2. **Authority:**
   - **Entities and schema:** the Team entity attributes in every builder
     (`EntityLoader`, `teamRef` and its callers, `MembershipService.loadUnits`), and the
     Cedar schema;
   - **Policies:** the unit-role clause in `grantToPolicies`, `Team` in
     `GROUP_SCOPABLE`, and the `scopeCondition` branches;
   - **Team actions:** `team:create` as §2.5, and the `team:update` before-and-after
     check;
   - **Tests:** `policies.spec.ts` and e2e cases for a Writing lead (unit role) and a
     Writing division-scoped grant, each against USA[Writing],
     USA[Writing, Art] and USA[all].
3. **Web:** teams-admin, task-creation narrowing, the division and team pages, Admin ›
   Users, home, and the `supports()` helper.
4. **Docs and data:** ADR 0020, the glossary, and the seed (§6).
