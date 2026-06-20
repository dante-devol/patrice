# Patrice

Single-org task-tracking tool. See `docs/ARCHITECTURE.md` for the design,
`docs/slices/` for the build plan, and `UBIQUITOUS_LANGUAGE.md` for the glossary.

## Slice 1 — Foundation, Auth, Access Engine & Bootstrap

The first vertical slice is implemented: a fresh install boots, mints a bootstrap
key, lets the first person register as admin through the invite flow, establishes a
session, and authorizes actions through the Cedar access engine.

### Run the whole stack (Docker)

```bash
docker compose up --build
```

- Postgres 18, Mailpit (SMTP UI at http://localhost:8025), the API (:3000), and the
  web app (http://localhost:8080).
- On an empty DB the API prints a **bootstrap key** to its logs. Visit
  http://localhost:8080/setup, paste the key, and register the first administrator.

### Run the API alone (against a local Postgres)

```bash
cd api
cp .env.example .env          # edit DATABASE_URL etc.
npm install
npx prisma migrate deploy     # applies the Slice 1 migration (needs PostgreSQL 18 for uuidv7())
npm run start:dev
```

The API prints the bootstrap key on boot when no effective admin exists.

### Run the web app alone

```bash
cd web
npm install
npm start                     # ng serve with a proxy to http://localhost:3000
```

### Tests

```bash
cd api
# Point at a Postgres 18 with an empty `patrice_test` database, then:
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/patrice_test npm run test:e2e
```

The e2e suite (`api/test/slice1.e2e-spec.ts`) covers the Slice 1 acceptance demo:
bootstrap-key presence, bootstrap redemption, the engine gating `POST /invitations`
(admin 201 vs base user 403), FCFS single-use invites, no-consume `GET /invite/:token`,
expired/revoked → 410, session httpOnly + logout revocation, no open sign-up, and
"restart with an admin prints no key".

## Layout

- `api/` — NestJS backend: Prisma, the Cedar access engine, auth/sessions/invitations,
  email + pg-boss. See `api/CONTEXT.md`.
- `web/` — Angular frontend (standalone, signals). See `web/CONTEXT.md`.
- `docs/` — architecture, slices, PRD, agent guides.

### Known follow-ups carried from Slice 1

- **OpenAPI emission + generated client + TanStack Query.** The pinned stack calls
  for code-first OpenAPI from the API's Zod schemas and a generated web client. Slice 1
  ships a hand-written data layer (`web/src/app/core/api.*`) to stay runnable; wiring the
  codegen pipeline is a tracked follow-up on the Slice 1 umbrella (#2).
