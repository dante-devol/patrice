# Patrice

Patrice is a **self-hosted work-tracking platform** — an API and a web UI that give a team
structured tools for **tracking work**, **managing users and access**, and **syncing with the
third-party services they already run on**. It's built to be **rolled by the team that uses it**:
you stand up your own instance, then shape it to your organization through configuration rather
than code.

The premise is simple: a serious team's coordination problem is, underneath, a database problem —
who's doing what, who's allowed to do what, what's been submitted, what's blocked. Patrice owns
that database and puts an approachable web service in front of it, so the people running the work
never have to touch the schema to make it fit how they actually operate.

## Configuration, not code

Almost everything that looks organization-specific in Patrice is **data you configure**, not
software you fork:

- **Roles** are the authorization atom. You define them; a user can hold many.
- **Divisions** (kinds of labor) and **teams** (content-facing groups) each own an *inherent
  role* whose possession **is** membership.
- The **permission matrix** is editable: every gated action is a `resource:verb` grant you assign
  to roles, scoped globally / to a group / to ownership. There's one access engine — no bespoke
  per-feature rules.
- **Questionnaires** define what each kind of task asks for and collects (seven question types);
  divisions supply defaults, and task authors can customize per task.
- **Integrations** (which external groups map to which Patrice roles, in which direction) are
  configured per connection.
- Org behavior — session lifetimes, the retire→revive grace window, self-review, Discord sign-in
  credentials — is **runtime settings**, edited in the admin UI, not redeploys.

The software ships the engine, the lifecycle rules, and the UI; your instance's particulars are
just rows.

## What you get

**Work tracking.** Tasks carry a required division, optional team, a requester, markdown
description, claimant **slots**, a per-division **questionnaire**, versioned **submissions**, a
derived **status** (rolled up from slots by a min-rule), and a one-level-threaded **message**
stream with **attachments**. Requesters approve / return / reject submissions; views are paginated
and faceted for teams running hundreds of items.

**Users & access.** Accounts are **invitation-only** — a bearer-token invite, or the one-time
**bootstrap key** printed on a fresh install, is the only way in (no open sign-up). Sign in with
**email/password** or **Discord**. Identity is native and never depends on an integration. A single
**Cedar**-backed pipeline in the API authorizes *every* action; the web re-authorizes server-side
on each call (client guards are UX only). A hard **administrability guard** keeps an instance from
ever losing its last admin.

**Third-party integrations.** Connect a Discord guild and **map Discord roles ↔ Patrice roles**,
**inbound / outbound / bidirectional**. Members link their own Discord account (and can sign in
with it); role changes reconcile both ways — promptly via a Gateway listener and a ~5s debounced
per-user pulse, with a periodic floor sweep as the correctness backstop. Admins get a **health
surface** (gateway state, last/next reconcile, broken mappings with one-click retry) and
plain-language alerts when a push is refused — no log-reading or developer required. Security-
critical roles are carved out so they're never gated on sync.

**Lifecycle & data hygiene.** Nothing is hard-deleted on demand: entities are **retired** (hidden,
and hard-denied by the access engine), **revivable** within a configurable grace window, then
**garbage-collected** once unreferenced — task aggregates as a unit, users **scrubbed in place** to
a tombstone (GDPR-style erasure), orphaned blobs reconciled.

**Awareness.** A durable notification table plus a thin **SSE** "go sync" stream (reconcile-on-
connect; durability never rides the stream).

## Architecture

Three strictly-bound tiers, each replaceable without rewriting its neighbors:

```
Web (Angular)  ──HTTP / OpenAPI──▶  API (NestJS)  ──Prisma / SQL──▶  Postgres 18 + object store
  signals-first                     Cedar engine · sessions · pg-boss queue · SSE · integrations
```

- **API** is the only tier that talks to the database and the only one that enforces permissions.
  Ports & adapters keep the domain core framework-independent. It runs in two roles from one image
  — `api` (HTTP) and `worker` (queue consumers, cron, GC, and the integration Gateway socket).
- **Web** holds no domain logic — it reflects API state; the OpenAPI contract is the boundary.
- **Postgres** is the spine (single-node target: ~200 users / ~100k tasks). Attachments live in an
  object store (local-fs for single-instance dev, S3-compatible for production).

One organization per deployment — Patrice is something a team **runs for itself**, not a
multi-tenant SaaS. The multi-org seams exist in the model but multi-tenancy is deliberately not
built.

## Getting started

The whole stack runs in Docker:

```bash
docker compose up --build
```

This brings up Postgres, a local mail sink, the API + worker, and the web UI on
**http://localhost:8080**. On an empty database the API prints a one-time **bootstrap key** to its
logs — open `/setup`, paste it, and register the first admin.

Full dev-environment setup (Docker details, secrets, optional AWS/KMS and Discord credentials,
tests, and running the tiers without Docker) is in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Project layout

- `api/` — NestJS backend: the Prisma schema/migrations, the Cedar access engine, auth / sessions /
  invitations, tasks / questionnaires / submissions, attachments + object storage, notifications
  (SSE), the GC sweep, the pg-boss queue, and the integrations adapter + Gateway listener. See
  [`api/CONTEXT.md`](api/CONTEXT.md).
- `web/` — Angular frontend (standalone components, signals-first). See [`web/CONTEXT.md`](web/CONTEXT.md).
- `docs/` — the [architecture](docs/ARCHITECTURE.md), [ADRs](docs/adr/), the ordered build
  [slices](docs/slices/) (the project's construction history), and agent guides.
- [`CONTEXT-MAP.md`](CONTEXT-MAP.md) / [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) — the
  cross-tier domain language.
