# Patrice — Vertical Slices: Overview

> **Companion to `../ARCHITECTURE.md`.** That document is the *design*; this folder is the
> *build plan*, split into **ordered, full-stack, independently testable slices**. We
> deliberately **avoid horizontal layering** (no "build the DB, then the API, then the UI"):
> every slice cuts top-to-bottom and ends in a **runnable, testable demo**.
>
> **How to use this folder.** Read **this overview** (short, shared) plus the **one slice
> file** you're implementing. Each slice file is self-contained for its slice — it specifies
> exactly what to add (schema, endpoints, access rules, Angular pieces, tests) given the
> working codebase from earlier slices, and references prior slices only by name. You do not
> need `ARCHITECTURE.md` or the other slice files.

## Slice files
| # | File | Goal (demo) | Depends on |
|---|---|---|---|
| 1 | [`01-foundation-auth-engine-bootstrap.md`](01-foundation-auth-engine-bootstrap.md) | Fresh deploy → bootstrap key → register first admin → logged in; access engine gates an action. | — |
| 2 | [`02-org-configuration.md`](02-org-configuration.md) | Admin CRUDs roles/divisions/teams, edits the permission matrix, grants roles; scoped permissions take effect. | 1 |
| 3 | [`03-questionnaires.md`](03-questionnaires.md) | Admin builds a division's default questionnaire from the 7 question types; it renders & validates. | 2 |
| 4 | [`04-tasks-creation-claiming-messages.md`](04-tasks-creation-claiming-messages.md) | Create a task (gets a questionnaire copy), claim within openings, hold a threaded conversation. | 3 |
| 5 | [`05-submissions-review-lifecycle.md`](05-submissions-review-lifecycle.md) | Claimant submits answers; requester reviews; status follows the min-rule to Approved. | 4 |
| 6 | [`06-notifications.md`](06-notifications.md) | An event produces a notification delivered live over SSE; badge updates. | 5 |
| 7 | [`07-retirement-garbage-collection.md`](07-retirement-garbage-collection.md) | Retire (hard-deny), revive within grace, GC after grace; user scrub-in-place. | 1–6 |
| 8 | [`08-integrations-discord.md`](08-integrations-discord.md) *(post-v1)* | Connect a Discord guild, link a user, map role↔group, sync. | 1,2,7 |

Order is dependency-driven. Don't start a slice until the prior one's tests are green.

---

## Pinned tech stack (decisions — do not re-litigate)

These were left as build-time picks in the design; they are now **fixed** so no slice has
open tooling questions.

**Deployment topology.** v1 is **single-instance API**. The design seams for multi-instance
HA (the `PubSubPort` for SSE fan-out in Slice 6, fresh-per-request `config_version` reads in
Slice 1, the GC sweep `singletonKey` in Slice 7, the bootstrap-invitation uniqueness index
in Slice 1, and the local-fs attachment-driver caveat in Slice 4) are in place so multi-
instance becomes a deployment-topology decision rather than a redesign. **Local-fs object
storage requires single-instance**; multi-instance deployments must use the S3-compatible
driver.

| Concern | Pick |
|---|---|
| **DB** | PostgreSQL 16+ (single node). PKs = **UUIDv7**. |
| **ORM / migrations** | **Prisma** (+ Prisma Migrate; hand-edit generated SQL for partial indexes / `citext` / GIN). |
| **API runtime/framework** | **Node.js + TypeScript + NestJS** (DI + modules; mirrors Angular's DI ethos; ports-&-adapters). |
| **API validation** | **Zod** at the boundary; **emit OpenAPI** from the Zod schemas (code-first). |
| **Auth hashing** | **argon2** (`node-argon2`). Tokens hashed with SHA-256 + a startup pepper. |
| **Access engine** | **Cedar** via `@cedar-policy/cedar-wasm`. |
| **Background jobs / queue** | **pg-boss** (Postgres-backed). GC sweep, email send, and (post-v1) integration sync run here. |
| **Notifications transport** | **SSE** (`text/event-stream`), thin "go sync" signal. |
| **Object storage** | **S3-compatible** via AWS SDK v3 (MinIO for self-host); a **local-filesystem** driver behind the same port. |
| **Email** | **SMTP** via `nodemailer`. |
| **Web** | **Angular** (standalone components, signals-first, OnPush, new control flow). |
| **Web data layer** | typed client **generated from OpenAPI** (`openapi-typescript`); server-state via **TanStack Query (Angular)** bridged to signals. |
| **TLS** | terminated at a reverse proxy (Caddy/nginx); app assumes it sits behind TLS. |

**Auth scope note:** v1 ships **email+password only**. Google OAuth is a later add-on that plugs
into the same invite/registration flow (the `provider` enums already include `google`); it is
**not** implemented in Slice 1.

---

## Global conventions (apply to every slice)

- Every domain entity: `id uuid` (v7) PK; `created_at`/`updated_at timestamptz` (UTC).
- Tenant tables carry `organization_id` (always the singleton org in v1).
- Mutable aggregate roots carry an integer `version` (optimistic locking: update `WHERE id=? AND version=?`, 0 rows ⇒ `409 Conflict`).
- Core entities carry `lifecycle_state` (`active|retired`; users add `deactivated`) + `retired_at`; FKs to core data use **`ON DELETE RESTRICT`** — build this in from each entity's first slice, even before GC (Slice 7) exists.
- The API is the **only** permission-enforcing tier. Every mutating endpoint goes through the access engine (Slice 1); declare each endpoint's required `resource:verb` action. The Angular client **reflects** permissions for UX but never enforces them.
- **Derive, don't store**, unless storage buys a specific query gain. Status, lock states, and
  similar conditions are computed on read; `status_cache` is the named exception (recomputed on
  every state-affecting write), and `invitation`'s status is a read-time CASE over
  `revoked_at`/`use_count`/`expires_at` (Slice 1).
- Errors: JSON `{ error: { code, message, details? } }`. Denials → `403`; unauthenticated → `401`; validation → `422`; optimistic-lock → `409`.
- All times server-authoritative UTC.

## Glossary — load-bearing terms

- **Effective admin.** At least one **active** user holding a `permit` grant for one of
  `{grant:create, grant:update, grant:retire, role:create, role:update, role:retire}` at
  **`scope_kind='global'`** (scoped grants do **not** count). This single predicate drives
  Slice 1's bootstrap "no-effective-admin" trigger and Slice 2's administrability invariant
  (any write that would reduce the effective-admin count to zero is refused with
  `409 LAST_ADMIN`). Read this definition from both call sites; never re-derive it.

---

## Cross-slice notes for implementers

- **Each slice ends green-and-demoable.** Don't start a slice until the prior one's tests pass.
- **The access engine (Slice 1) is the spine.** Every later slice only *registers new actions +
  grants/policies* with it and declares each endpoint's required action — never re-implements authz.
- **Vocabulary is fixed (Slice 2).** New endpoints map to existing `resource:verb` actions; do not
  invent actions outside the registered set.
- **Status is always derived** (Slice 5 owns the min-rule). Never let a client set status.
- **Retirement is uniform** (Slice 7). Build every entity with `lifecycle_state`/`retired_at` and
  `ON DELETE RESTRICT` from its first slice.
- **Reflect-don't-enforce on the client.** The Angular app mirrors grants for UX; the API is the
  only authority.
