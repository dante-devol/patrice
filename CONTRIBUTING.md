# Contributing — dev environment

Patrice runs as a small fleet of services (API, background worker, web UI, Postgres, a mail sink,
and a dev Vault). The supported way to develop is **Docker Compose** — one command brings the whole
thing up the way it runs in practice. Running the tiers natively is possible too and is covered at
the end.

## Prerequisites

- **Docker** + the Compose plugin (`docker compose …`). That's all you need for the standard path.
- For the native path only: **Node 22** and **PostgreSQL 18** (the schema uses the built-in
  `uuidv7()`, which is 18+).

## Quick start (Docker)

From the repo root:

```bash
docker compose up --build
```

That starts:

| Service | What | Where |
|---|---|---|
| `web` | Angular UI (nginx, proxies `/api`) | http://localhost:8080 |
| `api` | NestJS HTTP role | http://localhost:3000 |
| `worker` | queue consumers · cron · GC · Discord Gateway | (no HTTP) |
| `db` | Postgres 18 | `localhost:5432` (`patrice`/`patrice`) |
| `mailpit` | SMTP sink + inbox UI (for verify/reset emails) | http://localhost:8025 |
| `vault` + `vault-init` | dev Vault + transit engine (a secret-cipher option) | http://localhost:8200 |

On an **empty database** the API prints a one-time **bootstrap key** to its logs:

```bash
docker compose logs api | grep "BOOTSTRAP KEY"
```

Open **http://localhost:8080/setup**, paste the key, and register the first admin. From there
everything (roles, divisions, teams, the permission matrix, questionnaires, integrations) is
configured in the admin UI.

### Day-to-day

```bash
docker compose up -d --build api worker     # rebuild + restart after API/worker code changes
docker compose up -d --build web            # rebuild the web UI
docker compose logs -f worker               # follow worker logs (sync, Gateway, GC)
docker compose down                         # stop (keeps data)
docker compose down -v                      # stop + wipe the DB volume (fresh bootstrap next up)
```

The API image runs as two **process roles** from one build: `api` (HTTP only) and `worker`
(background jobs + the integration Gateway socket). Compose runs them as separate containers;
that split is real, so a change to background/sync code needs the **worker** rebuilt, and a change
to an HTTP route needs the **api** rebuilt.

## Secrets & overrides

Compose ships **throwaway dev defaults** for every secret, so the quick start works with no setup.
To override any of them, create a `.env` **in the repo root** (Compose reads it automatically):

```bash
# .env (repo root) — all optional in dev; override the throwaway defaults
SESSION_SECRET=...            # ≥16 chars; also derives the OAuth-secret encryption key
TOKEN_PEPPER=...              # session/invite token hashing pepper
INTEGRATION_TOKEN_KEY=...     # 64 hex chars (32 bytes) — AES key for the bot-token cipher
COOKIE_SECURE=false           # true behind TLS
```

> ⚠️ This stack is **for development/evaluation only** — plain HTTP on localhost, throwaway
> secrets, dev-mode Vault. For production you must at minimum terminate TLS (`COOKIE_SECURE=true`),
> supply strong unique `SESSION_SECRET`/`TOKEN_PEPPER`, use the S3 storage driver, and replace
> dev Vault with a real cluster or KMS.

Note: **Discord OAuth credentials are not env vars** — they're runtime config entered in the admin
UI (see below). Per-connection Discord **bot tokens** are entered in the Integrations admin UI and
stored encrypted; they're never in env or compose.

## Secret-at-rest cipher (AEAD by default; KMS/Vault deferred)

The Discord **bot token** is encrypted at rest via the `SecretCipherPort`. The **only active**
backend is the **AEAD env-key** adapter (`INTEGRATION_TOKEN_KEY`) — the dev compose ships a
throwaway key, and connecting an integration encrypts the token automatically. For a single-org
self-host this is the right tool; just **override the throwaway key** for any persistent data and
keep it out of DB backups.

**You do not need AWS for development.** The **KMS** and **Vault** adapters exist but are currently
a **decrypt-only, downstream seam** — `encrypt()` always uses AEAD, so Patrice never produces
`kms:`/`vault:` handles today. Making them first-class (and broadening secret-at-rest beyond the
bot token) is tracked in **[#65](https://github.com/dante-devol/patrice/issues/65)**.

If you're working on that issue: the worker mounts `./.aws` read-only at `/root/.aws`
(`cp .aws/credentials.example .aws/credentials`), and `KMS_KEY_ID` / `AWS_REGION` (root `.env`)
point at a key with `kms:GenerateDataKey` + `kms:Decrypt`. The dev `vault` service already runs a
transit engine for the Vault adapter. Prefer an instance role over a static key file for anything
real — see the issue for why.

## Discord (optional)

To exercise Discord sign-in and role sync end-to-end you need a Discord application:

1. In the [Discord developer portal](https://discord.com/developers/applications), create an app.
   Under **OAuth2**, add the redirect URI **`http://localhost:8080/api/auth/discord/callback`** and
   copy the **Client ID** + **Client Secret**.
2. In Patrice, go to **Admin → Settings → Discord sign-in (OAuth app)** and paste them. (The secret
   is encrypted at rest with a `SESSION_SECRET`-derived key — see `docs/adr/0006-…`.)
3. For role sync, add a **bot** to the app, invite it to your guild with the **Manage Roles**
   permission and **its role placed above** any role it will manage, then add the connection +
   bot token under **Admin → Integrations**, and create role↔role mappings there.

All of this is runtime config — no rebuild, no env changes.

## Tests & checks

CI runs typecheck + lint + unit + e2e (API, against a real Postgres) and typecheck + lint + unit +
build (web). To run them locally:

**API** — unit specs need nothing; the e2e suite needs a Postgres 18 with a `patrice_test` database:

```bash
cd api
npm install
npm test                       # unit specs
npm run lint && npm run typecheck

# one-time: create + migrate the e2e DB (defaults to localhost:5432/patrice_test)
createdb -U postgres patrice_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/patrice_test?schema=public \
  npx prisma db push
npm run test:e2e               # full slice acceptance suites (--runInBand)
```

> The Docker stack applies schema with `prisma migrate deploy` on boot; for a scratch/test DB,
> `prisma db push` is the quickest way to materialize the current schema.

**Web**:

```bash
cd web
npm install
npm test
npm run lint && npm run typecheck && npm run build
```

## Running natively (without Docker)

Useful for fast inner-loop work on one tier. You'll need your own Postgres 18 and (for the email
flows) an SMTP sink — `docker compose up -d db mailpit` gives you both.

**API** (`:3000`):

```bash
cd api
cp .env.example .env           # fill DATABASE_URL, SESSION_SECRET, TOKEN_PEPPER, SMTP_URL …
npm install
npx prisma migrate deploy      # build the schema
npm run start:dev              # prints the bootstrap key when no effective admin exists
```

Leaving `PROCESS_ROLE` unset runs a **combined** process (HTTP + background jobs in one) — the
right choice for native dev.

**Web** (`:4200`, proxies `/api` → `http://localhost:3000`):

```bash
cd web
npm install
npm start
```

Then open http://localhost:4200/setup and bootstrap as above.

## Conventions

- TypeScript end to end; both tiers have `tsc` typecheck + flat-config ESLint. Keep new code warning-
  clean and match the surrounding style.
- The domain language is load-bearing — see [`api/CONTEXT.md`](api/CONTEXT.md),
  [`web/CONTEXT.md`](web/CONTEXT.md), and [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) before
  introducing new terms. Architectural decisions are recorded as ADRs in [`docs/adr/`](docs/adr/).
