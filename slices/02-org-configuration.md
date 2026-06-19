# Slice 2 — Org Configuration (Roles, Divisions, Teams, Matrix, Memberships)

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slice 1 (access engine, auth, the
`role`/`grant`/`user_role` tables).*

**Goal.** Give the admin the full configuration surface: create/update/retire **roles**,
**divisions**, **teams**; edit the **permission matrix** (grants); and **grant/revoke roles** to
users (membership). This exercises the CRUD-minus-Read + faces vocabulary and **scoped**
permissions end-to-end.

**Acceptance demo.**
1. Admin creates a **Writing** division (an inherent `role` is auto-created), a **USA** team, and a
   standalone **WritingLead** role.
2. Admin opens the **Permission Matrix** and grants `WritingLead` the action `task:review` scoped to
   **own_division=Writing** (the action exists as config even before tasks).
3. Admin grants a user the `WritingLead` role.
4. That user now passes a Cedar check for `task:review` on a Writing-scoped resource and is denied for
   an Art-scoped one (tested via an engine unit test; real `task:review` lands in Slice 5).
5. Admin tries to remove their own last admin grant → **refused** (administrability invariant).

**In scope.** `division`, `team` tables; inherent-role auto-creation; the full **action vocabulary**
registered with the engine (so grants can reference any action, even ones whose endpoints arrive
later); the permission-matrix editor; membership management; the administrability invariant (real);
division `default_openings`/`openings_locked` (questionnaire default is null until Slice 3).

**Not in scope.** Questionnaire contents (Slice 3), tasks (Slice 4).

## Schema (add)
```
division   id, organization_id, name,
           default_openings int default 1, openings_locked bool default false,
           restrict_claims bool default false,           -- claim eligibility: must hold division's inherent role
           lifecycle_state, retired_at, version, created_at, updated_at
team       id, organization_id, name, restrict_claims bool default false,
           lifecycle_state, retired_at, version, created_at, updated_at
```
*(The division's default questionnaire is **not** a column on `division`; ownership lives on
`questionnaire.owner_division_id` — see Slice 3.)*

- Creating a `division`/`team` **atomically creates its inherent `role`** (`kind='division'|'team'`,
  the unique `division_id`/`team_id` set). Retiring a division retires its inherent role too.

**Claim eligibility composition.** Both `division.restrict_claims` and `team.restrict_claims` are
**ANDed**: if either is true the claimant must hold the corresponding inherent role; otherwise the
gate is open on that axis. Enforced in Cedar by the `task:assign @ own_as_claimant` template's
`when` clause, reading the resource's `restrict_claims` flags and the principal's
`memberDivisions`/`memberTeams` set attributes (Slice 1 principal-resolution).

## Action vocabulary (register **all** of these with the engine now)
Closed `resource:verb` set; admins assign via grants, cannot invent actions. (Endpoints for some
arrive in later slices, but the engine knows them so the matrix can grant them.)
```
task:        create, update, retire, revive, assign, submit, review, retire_submission,
             complete, configure_questionnaire, manage_claims, change_requester
message:     create, update, retire, revive
attachment:  create, retire, revive
user:        update, retire, revive, deactivate, reactivate, grant_role, revoke_role
session:     revoke
invite:      create, retire
role:        create, update, retire, revive
division:    create, update, retire, revive
team:        create, update, retire, revive
grant:       create, update, retire, revive
config:      update
```
`*:revive` actions are seeded with global-scoped Admin grants by default; admins may delegate
narrower revive authority through the matrix (Slice 7 wires the endpoints). `user:reactivate` is
the inverse of `user:deactivate` (the in-life reversible cycle, distinct from retire/revive).
`session:revoke` carries scope **G** (any session) and **O** (own = session's user); `/auth/logout`
is gated by `session:revoke @ own`.

Scope tags per action and the `own`-relationship per action are as in the design. The
**template library** has five scope-shape templates: **`global`**; **`specific_group`**
(`resource in ?group`, used by `specific_division`/`specific_team`); **`own_group`**
(`resource.division in principal.memberDivisions` / `resource.team in principal.memberTeams`,
used by `own_division`/`own_team`); **`own`** (per-resource owner relation — actually a small
family of templates `own_as_requester` / `own_as_claimant` / `own_as_sender` / `own_as_uploader`
selected per action by the projector); **`role`** (for `user:grant_role`/`revoke_role`, target
role pinned via `scope_role_id`). **Inherent-role grants always project as `specific_*`,
never `own_*`** — their scope is structurally fixed to their division/team.

## Membership & scoped role-granting
- `user:grant_role` / `user:revoke_role` are **scoped by the granted role** (`scope_kind='role'` +
  `scope_role_id`). On grant, validate the actor may grant that specific role; **re-validate** at
  apply time. "Remove a user from a team" = `user:revoke_role` of that team's inherent role.

## Administrability invariant (real)
Before any write that could remove the last **effective admin** (see the precise predicate in
`00-overview.md`'s glossary — global-scope `grant:*` or `role:*` grants only), compute the count
post-write; if it would reach zero, **refuse** (`409`, code `LAST_ADMIN`) and write an
`activity` row `verb='last_admin_refused'`. Covered paths: editing/retiring `grant` rows that
hold a governance grant, deleting/retiring/deactivating the last effective admin, retiring the
Admin role, revoking the last effective admin's role.

## API endpoints
```
roles:       POST /roles (role:create) · PATCH /roles/:id (role:update) · POST /roles/:id/retire (role:retire) · GET /roles
divisions:   POST /divisions (division:create) · PATCH /divisions/:id (division:update) · POST /divisions/:id/retire (division:retire) · GET /divisions
teams:       POST /teams (team:create) · PATCH /teams/:id (team:update) · POST /teams/:id/retire (team:retire) · GET /teams
grants:      GET /grants · POST /grants (grant:create) · PATCH /grants/:id (grant:update) · POST /grants/:id/retire (grant:retire)
membership:  POST /users/:id/roles {roleId} (user:grant_role, scoped) · DELETE /users/:id/roles/:roleId (user:revoke_role, scoped)
users:       GET /users · PATCH /users/:id (user:update) · POST /users/:id/deactivate (user:deactivate) · POST /users/:id/reactivate (user:reactivate) · POST /users/:id/retire (user:retire)
config:      GET /config · PATCH /config (config:update)
```
**PATCH convention** (applies to `roles`/`divisions`/`teams`/`users`/`tasks` here and later):
each entity's `PATCH` endpoint accepts **only pure metadata** (`name`, `description`-like
fields). Lifecycle (`retire`/`revive`/`deactivate`/`reactivate`), authority (`grant_role`/
`revoke_role`/`change_requester`), and aggregate-structure changes go through their named
action endpoints. `422` on any other field — silent ignore is forbidden.

Each grant write **bumps `organization.config_version`** and **re-projects** the affected Cedar links
(validate before activate). Reject invalid action/scope combos at `422`. Every config write also
logs to `activity` with one of the verbs registered here: `role.created`/`.updated`/`.retired`/
`.revived`, `division.created`/`.updated`/`.retired`/`.revived`, `team.*`, `grant.*`,
`user_role.granted`/`.revoked`, `user.deactivated`/`.reactivated`, `config.updated`,
`last_admin_refused` (the LAST_ADMIN guard rejections — a useful security signal).

## Organization settings (structured)
`PATCH /config` accepts a Zod-typed payload representing `organization.settings`. Slice 2 ships
these flags:
```ts
{
  requireVerifiedEmailToLogIn?: boolean,   // default false; gates login on user_identity.verified_at
  selfReviewAllowed?:           boolean,   // default false; controls the self-review forbid policy
  anonymizeLabel?:              boolean,   // default false; scrubbed users render as "Former member"
  sessionAbsoluteDays?:         number,    // default 30
  sessionIdleDays?:             number,    // default 7
}
```
The admin UI surfaces this as a structured form (not a JSON textarea). Flipping
`selfReviewAllowed` patches the Cedar policy set (adds/removes the self-review forbid) and bumps
`config_version`; flipping `requireVerifiedEmailToLogIn` does **not** invalidate existing sessions
(only gates new logins).

## Web (Angular)
- **Admin area** (lazy feature module): Roles list/editor, Divisions editor (name, default openings,
  openings-locked), Teams editor, **Users** list with a role-assignment panel, and the **Permission
  Matrix** editor (role × action grid with scope pickers). All as dumb components over signal stores;
  data via the OpenAPI client.
- Surface the `LAST_ADMIN` refusal as an inline error.

## Tests
- Inherent role auto-created/retired with division/team.
- Scoped grant: a `WritingLead` passes `task:review @ Writing`, fails `@ Art` (engine test).
- `user:grant_role` refused when the granted role exceeds the actor's grantable set.
- Administrability invariant refuses every last-admin-removal path.
- `config_version` bumps + Cedar re-projection on grant edits; cache invalidates.

**Done when** the demo passes and an admin can fully author org config that the engine honors.
