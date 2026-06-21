# Patrice

Patrice is a **task-tracking tool for a single organization** — built to replace a sprawl of
~20 Google Drive task-tracking sheets with one structured system. Work is contributed across
**divisions** (the kind of labor — Scripting, Writing, Art, Testing, Leadership…) and organized
into **teams** (content-facing groups). Members **request** and **claim** tasks; what a task
*asks for and collects* (its **questionnaire**) varies by division — writing submits text, art
submits files, testing fills a custom form. The org runs out of Discord, so Patrice can
optionally **sync** identity and roles with a guild — without ever depending on it.

> Design north stars (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)): one organization per
> deployment; **roles are the authorization atom**; almost everything org-specific is
> **configuration, not code**; one centralized access engine gates every action; and core data
> is **retired, then reference-counted-deleted**, never dropped outright.

## What it does

- **Accounts are invitation-only.** No open sign-up — a bearer-token invite (or the one-time
  **bootstrap key** on a fresh install) is the only way in. Email/password + Google OAuth.
- **Roles, divisions, teams, and a permission matrix** are all data. A role is the auth atom;
  each division/team owns an **inherent role** whose possession *is* membership.
- **One access engine.** Every gated action (`resource:verb`) is evaluated by a single
  **Cedar**-backed pipeline in the API — configurable grants, scoped global/own/by-group.
- **Tasks with per-division questionnaires.** Tasks deep-copy their division's default
  questionnaire (7 question types), carry claimant **slots**, a derived **status**, a markdown
  description, and a one-level-threaded **message** stream with **attachments**.
- **Submissions & review.** Each claimant submits answers (versioned); requesters
  approve / return / reject; a task's status rolls up from its slots by a min-rule.
- **In-app notifications.** A durable `notification` table + a thin **SSE** "go sync" stream
  (reconcile-on-connect; durability never rides the stream).
- **Lifecycle: retire → grace → GC.** Entities are soft-retired (hidden by default, hard-denied
  by the engine), **revivable** within a configurable grace window, then garbage-collected once
  unreferenced — including task-aggregate deletion, **user scrub-in-place** (GDPR-style erasure
  to a tombstone), and orphaned-blob cleanup.

## Architecture

Three strictly-bound tiers, each replaceable without rewriting its neighbors:

```
Web (Angular)  ──HTTP / OpenAPI──▶  API (NestJS)  ──Prisma / SQL──▶  Postgres 18 + object store
   signals-first                    Cedar engine · sessions · pg-boss queue · SSE
```

- **API** is the only tier that talks to the database and the only one that enforces
  permissions. Ports & adapters keep the domain core framework-independent.
- **Web** holds no domain logic — it reflects API state and re-authorizes every action
  server-side (client guards are UX only).
- **Postgres** is the spine (single-node target: ~200 users / ~100k tasks). Attachments live in
  an object store (local-fs for single-instance dev, S3-compatible for production).

See [`CONTEXT-MAP.md`](CONTEXT-MAP.md), [`api/CONTEXT.md`](api/CONTEXT.md), and
[`web/CONTEXT.md`](web/CONTEXT.md) for the per-tier domain language.

## Implementation state

The product is built in ordered, full-stack [slices](docs/slices/). **Slices 1–7 (v1) are
complete**; Slice 8 (Discord) is explicitly post-v1.

| Slice | Capability | Umbrella | State |
|---|---|---|---|
| 1 | Foundation · auth · sessions · Cedar engine · bootstrap | #2 | ✅ |
| 2 | Org config: roles, divisions, teams, permission matrix, memberships | #7 | ✅ |
| 3 | Questionnaires (7 question types, division defaults) | #12 | ✅ |
| 4 | Tasks · claiming · message threads · attachments | #16 | ✅ |
| 5 | Submissions · review · status min-rule | #20 | ✅ |
| 6 | Notifications (durable table + SSE stream) | #24 | ✅ |
| 7 | Retirement, grace-period revive & garbage collection | #27 | ✅ |
| 8 | Integrations (Discord): connect · link · map · sync | #40 | ⬜ post-v1 |

**Tooling.** Both tiers have `tsc` typecheck + flat-config ESLint + a test runner (Jest), and a
GitHub Actions CI runs typecheck/lint/unit/e2e (api, against a real Postgres) and
typecheck/lint/unit/build (web) on every PR.

**Known follow-up:** the Web↔API contract is meant to be code-first **OpenAPI** with a generated
client; v1 ships a hand-written data layer (`web/src/app/core/api.*`) to stay runnable — wiring
the codegen pipeline is tracked on the Slice 1 umbrella (#2).

## Running it locally

Requires **PostgreSQL 18** (the schema uses the built-in `uuidv7()`).

### Whole stack (Docker)

```bash
docker compose up --build
```

Brings up Postgres, **Mailpit** (SMTP inbox UI at http://localhost:8025), the API (`:3000`), and
the web app (http://localhost:8080). On an empty DB the API prints a one-time **bootstrap key**
to its logs — visit http://localhost:8080/setup, paste the key, and register the first admin.

### Tiers separately (dev)

**API** (`:3000`):

```bash
cd api
cp .env.example .env          # fill DATABASE_URL, secrets, SMTP; validated on boot (fail-fast)
npm install
npx prisma migrate deploy     # build the schema on a Postgres 18
npm run start:dev
```

The API prints the bootstrap key whenever no **effective admin** exists (first boot or recovery).

**Web** (`:4200`, proxies `/api` → `http://localhost:3000`):

```bash
cd web
npm install
npm start
```

Then open http://localhost:4200/setup and bootstrap as above.

> A local SMTP sink is handy for the email-verification / password-reset flows — `docker compose
> up mailpit` gives you one at `smtp://localhost:1025` (UI on `:8025`).
>
> **Grace period** (the retire→revive window) and other behaviors are runtime **org settings**
> (`organization.settings`, edited in the admin UI), not env — e.g. `gracePeriodHours` (default 24h).

## Tests & quality

```bash
# API — unit + e2e (e2e needs a Postgres 18 with an empty `patrice_test` DB)
cd api
npm test                                  # unit specs
npm run lint && npm run typecheck
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/patrice_test?schema=public \
  npx prisma migrate deploy               # one-time: build the test schema
npm run test:e2e                          # full slice acceptance suites

# Web — unit + lint + typecheck + build
cd web
npm test
npm run lint && npm run typecheck && npm run build
```

## Layout

- `api/` — NestJS backend: Prisma schema/migrations, the Cedar access engine, auth / sessions /
  invitations, attachments + object storage, notifications (SSE), the GC sweep, and the pg-boss
  queue. See [`api/CONTEXT.md`](api/CONTEXT.md).
- `web/` — Angular frontend (standalone components, signals-first). See [`web/CONTEXT.md`](web/CONTEXT.md).
- `docs/` — [architecture](docs/ARCHITECTURE.md), the [build slices](docs/slices/), the
  PRD (#1), ADRs, and agent guides.
- `UBIQUITOUS_LANGUAGE.md` — the cross-tier glossary.
