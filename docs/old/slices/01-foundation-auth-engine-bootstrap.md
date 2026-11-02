# Slice 1 — Foundation, Auth, Access Engine & Bootstrap

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** nothing (this is the foundation).*

**Goal.** Stand up the three tiers wired end-to-end, and deliver the irreducible core: a fresh
install boots, mints a **bootstrap key**, lets the first person register as **admin** through the
normal invite/registration flow, establishes a **session**, and authorizes their actions through
the **Cedar access engine**. Every later slice extends this.

**Acceptance demo.**
1. `docker compose up` (Postgres + API + Web) on an empty DB. Migrations run.
2. API logs print a **bootstrap key** to stdout (because there is no effective admin).
3. Visit the web app → setup page → enter the bootstrap key → register (email+password) → you are
   logged in as admin (httpOnly session cookie set).
4. As admin, `POST /invitations` succeeds (you hold the grant). Accept that invite as a second user
   (a "base user" with no roles). That base user's `POST /invitations` returns **403** (no grant).
   ← proves the engine works.
5. Restart the API while an admin exists → **no** bootstrap key printed.

**In scope.** Project scaffolding & three-tier wiring; startup config; Prisma + migrations;
identity/session/invitation tables; **email+password** auth; sessions (cookie, CSRF); invitations
(incl. bootstrap-as-special-invite) + email verification/reset; the Cedar access engine (roles,
grants, projection, principal resolution, authorize guard, org-wide version-stamp cache); the
seeded **Admin** role.

**Not in scope.** Google OAuth (later add-on — the `provider`/`auth_method` enums include `google`
but only `password` is implemented here); roles/divisions/teams CRUD UI (Slice 2); tasks,
questionnaires, notifications, retirement sweeps (later). Only the actions this slice needs exist.

## Startup config (env)
Load + validate on boot (fail fast). Keys: `DATABASE_URL`; `PUBLIC_BASE_URL`; `SESSION_SECRET`;
`TOKEN_PEPPER`; `ARGON2_*` (optional); `SMTP_URL` + `EMAIL_FROM`; `LOG_LEVEL`; `NODE_ENV`;
`COOKIE_SECURE` (bool), `TRUST_PROXY` (bool). *(Google OAuth env vars are added when that add-on
lands.)* No DB-secret master key (integration auth is delegated to providers in later slices).

## Schema (create these tables)
```
organization      id, name, settings jsonb (default '{}'), config_version bigint default 0, created_at, updated_at
                  -- singleton: enforce one row (app guard + a CHECK on a constant column)
app_user          id, organization_id, email citext null UNIQUE(organization_id,email),
                  display_name text, created_via_invitation_id uuid null,
                  lifecycle_state ('active'|'deactivated'|'retired') default 'active',
                  deactivated_at null, retired_at null, version int default 0, created_at, updated_at
user_identity     id, user_id→app_user, provider ('password'|'google'),     -- only 'password' built here
                  provider_subject text null, password_hash text null,
                  verified_at timestamptz null,                              -- email-ownership proof; password identities start null
                  created_at, updated_at
                  UNIQUE(provider,provider_subject), UNIQUE(user_id,provider)
session           id, user_id→app_user, token_hash text UNIQUE, auth_method ('password'|'google'),
                  created_at, last_seen_at, absolute_expires_at, idle_expires_at,
                  revoked_at null, ip inet null, user_agent text null
invitation        id, organization_id, token_hash text UNIQUE, email citext null,
                  intended_role_ids uuid[] null, passcode_hash text null,
                  max_uses int default 1, use_count int default 0, created_by uuid null,
                  created_at, expires_at, revoked_at timestamptz null
                  -- status is DERIVED on read: CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                  --   WHEN use_count >= max_uses THEN 'exhausted'
                  --   WHEN now() >= expires_at THEN 'expired' ELSE 'pending' END
                  -- Partial unique index for bootstrap-singleton:
                  --   CREATE UNIQUE INDEX one_bootstrap_invite ON invitation (organization_id)
                  --     WHERE created_by IS NULL AND revoked_at IS NULL
invitation_use    id, invitation_id→invitation, created_user_id→app_user, used_at
auth_token        id, user_id→app_user, kind ('email_verification'|'password_reset'),
                  token_hash text UNIQUE, created_at, expires_at, consumed_at null
role              id, organization_id, name, kind ('standalone'|'division'|'team'),
                  division_id uuid null UNIQUE, team_id uuid null UNIQUE,
                  lifecycle_state default 'active', retired_at null, version int default 0, created_at, updated_at
user_role         id, user_id→app_user, role_id→role, source ('patrice'|'integration') default 'patrice',
                  source_connection_id uuid null, granted_by uuid null, granted_at, updated_at
                  UNIQUE(user_id,role_id)
grant             id, organization_id, role_id→role, action text, effect ('permit'|'forbid') default 'permit',
                  scope_kind ('global'|'own'|'own_division'|'own_team'|'specific_division'|'specific_team'|'role'),
                  scope_division_id null, scope_team_id null, scope_role_id null, created_at, updated_at
activity          id (v7), organization_id, actor_user_id uuid null,
                  subject_type text, subject_id uuid,                    -- polymorphic; no FK
                  verb text, payload jsonb,
                  source ('patrice'|'integration'|'system'),
                  source_connection_id uuid null,
                  created_at
                  -- Append-only by convention (no UPDATE/DELETE from app).
                  -- INDEX (subject_type, subject_id, created_at); INDEX (created_at)
```
*(In Slice 1 only `kind='standalone'` roles exist — the seeded **Admin** role. Division/team
inherent roles arrive in Slice 2; the columns exist now.)*

**Scope-kind shapes** (vocabulary aligned with Slice 2's template library): five distinct
shapes — `global`, `specific_division`/`specific_team` (resource pinned to a fixed group),
`own_division`/`own_team` (resource in any group the actor is a member of), `own` (actor is
the resource's owner — relation varies per action: claimant for `task:submit`/`task:assign`,
requester for `task:review`/`task:complete`/`task:configure_questionnaire`/
`task:change_requester`/`task:manage_claims`/`task:retire_submission`, sender for `message:*`,
uploader for `attachment:*`), and `role` (target role pinned via `scope_role_id` — used by
`user:grant_role`/`user:revoke_role`). The projector applies a static **action → `own`
template** map at link time so `scope_kind='own'` stays a single admin-facing concept even
though it expands to several Cedar templates (`own_as_requester`/`own_as_claimant`/
`own_as_sender`/`own_as_uploader`).

### `activity` log + helper (introduced here, extended by every slice)
The org-level immutable audit log. **Append-only by convention in v1** (tamper-resistance
is §6.3-deferred). A `logActivity({actorUserId?, subjectType, subjectId, verb, payload,
source, sourceConnectionId?})` helper is the **only** entry point — its payload type is
**Zod-validated per verb** and **must not contain PII strings** (no `email`, no
`displayName` — only IDs and structured non-PII facts). PII is rendered by joining to
current state at read time, with a tombstone fallback for scrubbed users (Slice 7).
**Verbs registered in Slice 1:** `invite.created`, `invite.redeemed`, `invite.revoked`,
`bootstrap.completed`, `user.registered`. (Each later slice extends the verb catalog;
Slice 8 just *uses* the table.)

## Auth & sessions (email+password)
- **Register** sets a `user_identity(provider='password', password_hash=argon2(pw))`. **Login**
  verifies and creates a `session`. **Logout** revokes it. `GET /me` returns the current user
  plus `emailVerified: bool` so the client can nudge unverified users.
- **No account without an invite.** Registration happens **only** through invite acceptance
  (below); there is no open sign-up endpoint. (This is the v1 form of "no auto-provisioning.")
- **Sessions:** opaque random token in an **httpOnly + Secure + SameSite=Lax cookie**; store only
  `sha256(pepper+token)`. Absolute + sliding (idle) expiry from `organization.settings` (ship
  defaults: absolute 30d, idle 7d). **CSRF:** double-submit token or `SameSite` + a custom header
  check on mutations. A request resolves to **identity only**; permissions come from the access
  engine per request.
- **Email verification (verify-after-session by default; configurable).** `user_identity.verified_at`
  records the proof. Verification flow: `POST /auth/verify-email/resend` (throttled, returns
  success unconditionally to avoid an enumeration oracle) issues an `auth_token`; the link
  resolves to `POST /auth/verify-email/confirm`, which stamps `verified_at = now()` on the
  matching identity (no session is created — the user logs in separately). Google identities
  start `verified_at = created_at` (Google verifies upstream).
- **Org flag `requireVerifiedEmailToLogIn` (default `false`).** When true, `POST /auth/login`
  rejects unverified password identities with `403 EMAIL_NOT_VERIFIED` (distinct from auth
  failure so the client can route to "resend verification"). Flag flip does **not** invalidate
  existing sessions — only gates new logins. *Always-on invariant regardless of flag:* `POST
  /auth/password-reset/confirm` requires `verified_at IS NOT NULL` (closes the unverified-email
  account-hijack-via-reset path).
- **Bootstrap auto-verifies.** Bootstrap-invite redemption stamps `verified_at = now()` on the
  new password identity **unconditionally** — the brick-on-SMTP-broken risk for the first user
  outranks the flag. Documented exception.
- **Password reset:** issue `auth_token`, email a `PUBLIC_BASE_URL` link (nodemailer/SMTP).
  Reset consumption **revokes all the user's sessions** (the "doubt" path).

## Invitations (incl. bootstrap)
- **Create** (`invite:create`): generate a CSPRNG **nanoid** token (≥128 bits, URL-safe,
  unordered); store `token_hash`. Optional `email`, `intended_role_ids` (⊆ creator's grantable
  roles — trivially satisfied in Slice 1), `expires_at` (default now+7d), `max_uses=1`.
- **View** `GET /invite/:token` → **read-only** (returns invite metadata / registration form);
  **never** consumes. **Redeem** `POST /invite/:token/accept` → the *deliberate* action:
  - Atomic FCFS: `UPDATE invitation SET use_count=use_count+1 WHERE id=? AND use_count<max_uses
    AND revoked_at IS NULL AND now()<expires_at` → 0 rows ⇒ `409/410`. (Status is a derived
    enum on read; the WHERE-clause is authoritative for consumption.)
  - Runs the **email+password registration**, creates the `app_user` (`created_via_invitation_id`),
    writes an `invitation_use`, grants `intended_role_ids`.
- **Revoke** (`invite:retire`): set `revoked_at = now()`.
- **Bootstrap** = a passcode-gated **system invitation**: on boot, if there is **no effective
  admin** (no *active* user holding any grant for `grant:update` or `role:create|update|retire`),
  generate an **ephemeral** bootstrap key (lives only for this process run, printed to **stdout**,
  never persisted) and ensure a system invitation exists with `created_by=null`,
  `passcode_hash=sha256(key)`, `intended_role_ids=[AdminRole]`. Redeeming it requires the key as a
  passcode. When an effective admin exists, bootstrap mode is closed. A restart while unbootstrapped
  mints a **fresh** key (old key dead). This trigger doubles as **lockout recovery**.

## Access engine (the cross-cutting core — fully built here)
- **Seed** on first migration: the **Admin** role (`kind='standalone'`) with `grant` rows for every
  action defined so far (Slice 1: `invite:create`, `invite:retire`, scope `global`).
- **Projection:** maintain a **Cedar policy set** projected from `grant` rows. Implementation: a
  small fixed **template library** + one **template-link per grant**, rebuilt on startup and patched
  on any grant change; **plus a small set of static + conditional-static policies** —
  `forbid(when resource.retired)`, **baseline self-access** (`permit` on `user:update` when
  `resource == principal`), and the **self-review forbid** that is *present* in the policy set iff
  `organization.settings.selfReviewAllowed = false` (toggling the flag bumps `config_version` and
  patches the policy set). Validate each link against the Cedar **schema** before activating. The
  projector also applies the **action → `own` template** map (from the scope-shape note above) when
  a grant's `scope_kind='own'` so the right `own_as_*` template is bound per action.
- **Principal resolution:** per request, load the session's user + their `user_role`s as Cedar
  entities; the principal entity carries set attributes `memberDivisions` and `memberTeams`
  (derived from `user_role` joined to `role.division_id`/`team_id`) used by the `own_group`
  template and by claim-eligibility (Slice 4). **Cache** these inputs keyed on
  `organization.config_version`; bump `config_version` on any role/grant/retirement/org-settings
  change (org-wide). **`config_version` itself is read fresh from the DB per request** — it is one
  indexed-by-PK read and is the basis of cache-correctness under future multi-instance topologies;
  the inputs it keys are cached, the key is not. Cedar does `is_authorized(principal, action,
  resource)` per request (sub-ms).
- **Authorize guard (NestJS):** every mutating route declares its `action` + how to load the target
  resource; the guard builds the Cedar request and returns `403` on deny. **Retired entities** feed
  in with `resource.retired=true` (the static `forbid` wins). The **administrability invariant**
  check (refuse last-admin removal) is a write-time guard — a stub here (fully exercised in Slice
  2/7), but wired.

## API endpoints (Slice 1)
```
POST   /auth/login                  {email,password} → set cookie (rejects unverified
                                                                  identities if the org flag is on)
POST   /auth/logout                 → revoke session
GET    /me                          → current user + emailVerified bool
POST   /auth/password-reset         {email} → email link;  POST /auth/password-reset/confirm {token,pw}
POST   /auth/verify-email/resend    {email} → success (throttled; no enumeration oracle)
POST   /auth/verify-email/confirm   {token}
GET    /invite/:token               → invite metadata (read-only)
POST   /invite/:token/accept        {passcode?, email, password, displayName} → create user + session
POST   /invitations                 (invite:create) {email?, intendedRoleIds?, expiresAt?}
POST   /invitations/:id/revoke      (invite:retire)
GET    /invitations                 (invite:create) → list (status derived on read)
GET    /health                      → 200 (DB ping)
```

## Web (Angular)
- App shell with the **layered structure** (presentation / signal-store / OpenAPI data layer),
  router, an `AuthStore` (signal store) holding the current user, an HTTP interceptor that handles
  `401` (→ login) and CSRF header.
- Pages: **Setup/Bootstrap** (enter key + register), **Login**, **Accept Invite**, a minimal
  **authenticated home** ("Logged in as …"), **Invitations** (admin: create/list/revoke),
  password-reset request/confirm.
- Route guards reflect "is authenticated" / "can `invite:create`" (UX only).

## Cross-cutting introduced
- `pg-boss` wired (used by email send now; GC/sync later).
- SMTP/email adapter (port + nodemailer impl).
- The ports-&-adapters skeleton (domain core, HTTP adapter, persistence adapter via Prisma, email
  port, access-engine port).

## Tests (must pass)
- **Integration:** empty DB → boot → bootstrap key present in logs → accept bootstrap invite →
  admin session works. Restart with admin → no key.
- **Authz:** admin `POST /invitations` → 201; base user → 403.
- **Invites:** FCFS single-use (concurrent accept → exactly one wins); `GET /invite/:token` does
  **not** consume; expired/revoked invite → 410; passcode required for bootstrap invite.
- **Sessions:** cookie httpOnly/secure; logout revokes; password-reset revokes all sessions.
- **No open sign-up:** there is no registration path outside invite acceptance.

**Done when** the acceptance demo passes and the test suite is green.
