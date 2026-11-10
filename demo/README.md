# Patrice browser demo

A static build of Patrice that runs **the real API inside the visitor's browser**, so it
can be hosted on Cloudflare (or any static host) with no server, no database and
nothing to secure. Each visitor gets their own copy of the data, kept in their browser.

This is its own project, **outside the product**. It consumes `api/src` and the web
app's production build, and neither of them knows it exists: `scripts/check-isolation.mjs`
fails the build if `api/` or `web/` reference the demo.

```bash
npm ci                 # in demo/ (and npm ci in api/ and web/, whose packages it uses)
npm run build          # ~20 s → .build/site
npm run serve          # http://localhost:4400 (a plain static server)
npm run deploy         # patrice-demo Worker → patrice.dante-devol.dev
npm test               # browser checks against the local server (Playwright)
```

VS Code has the same as tasks: **Demo: Build**, **Demo: Deploy** (builds first) and
**Demo: Preview locally**.

Log in as `admin@example.com` / `correct horse battery` (the dev seed's users).

## Layout

| Path | What |
|---|---|
| `src/` | Composition root (`demo-app.ts`), request dispatcher, service worker, Node shims, the Node snapshot server |
| `web/` | Files served as-is: the start page (`demo.html`), the demo header (`header.js`), the boot script, the worker wrapper (`sw.js`) |
| `scripts/` | `make.mjs` (the whole build), `build.mjs` (worker bundle), `assemble.mjs` (site), `serve.mjs`, `check-isolation.mjs`, `diagnostics/` |
| `tests/` | Playwright checks: start flow, front door, header, switcher, sweep, stress, upgrade, Firefox |
| `.build/` | Everything generated (ignored): compiled code, the demo Prisma client, the snapshot, the worker, the site |

**How it uses the API without touching it:**
- **Compiling:** `tsconfig.json` compiles `src/` together with `../api/src`, with tsc, so
  Nest keeps its decorator metadata.
- **Packages:** they come from `api/node_modules` (one copy of Nest and Prisma), through
  `NODE_PATH` in Node and esbuild's `nodePaths` when bundling.
- **Prisma client:** `make.mjs` copies the API's schema with its generator swapped for a
  Rust-free, driver-adapter client, and generates it into
  `.build/node_modules/demo-prisma-client`. The copy sits in
  `api/node_modules/.cache/patrice-demo`, because Prisma must find `@prisma/client` from
  the schema's folder.
- **Peers:** `demo/.npmrc` turns off automatic peer installs, so npm never adds a second
  Prisma.

**Demo header (`web/header.js`).** A dark bar above the app on every demo page,
inserted before `<app-root>` in normal flow and rendered in a Shadow DOM, so the app's
styles, sticky bar and dialogs are unaffected. It has a back link to dante-devol.dev,
and once the demo is started, a link to the start page and who you're signed in as.
It reads that from `GET /__demo/state`, which the worker answers itself
(`src/demo-endpoints.ts`) by asking the real `/api/me`. The worker tells it when a login
or logout changes the session. Before the demo is started, only the back link shows.

**User switcher.** The header's button shows who you are and opens a menu of everyone
the demo knows:
- **Demo users,** from `personas.json`. The format is `[{ email, password, label,
  description }]`, and `scripts/personas.mjs` validates it. Until that file exists,
  the only demo user is the seed's admin.
- **Joined during the demo:** people who accepted an invitation here.
- **Invited:** pending invitations for an email address, with no account yet.
- **Anonymous.**

Choosing someone calls `POST /__demo/switch`, and the worker goes through the app's
real endpoints:
- **A member** is signed in with `POST /api/auth/login`, using their password.
- **Anonymous or an invitee** is signed out with `POST /api/auth/logout`.

So the app's rules apply: if it refuses a login (a deactivated user, say), the menu
shows its message and you stay who you were. When someone accepts an invitation, the
worker remembers the password from that request, so the switcher can sign in as them
later. That, and which invitee you're being, is kept per build alongside the cookie jar,
and cleared with the demo's data.

**Start page (`web/demo.html`, served at `/demo`).** A visitor without the demo set up
(no service worker registered) is sent there from any app URL, with `?next=` holding
where they were going. The page:

- explains the demo;
- shows whether this browser holds demo data, and how much;
- **Start / Continue:** installs the worker and starts the API, ticking off each stage
  the worker reports, then opens the app;
- **Clear demo data:** asks the worker to close its database, unregisters it, and
  deletes the database, cache and cookies.

The demo login is read from `api/scripts/seed.mjs` at assembly and shown on the start
page. `/?reset-demo` leads to this page.

## Hosting

Deploy the **whole** `.build/site/` folder (43 files) to the **root** of an address,
such as a subdomain. The app, the worker and the API all use root paths (`/sw.js`,
`/api/…`, `/login`).

- **Cloudflare Workers (static assets):** run `npm run deploy`, which uses
  `wrangler.jsonc`. That config turns on `not_found_handling:
  "single-page-application"`; without it, app routes like `/login` return 404.
- **Cloudflare Pages:** upload the folder; app routes fall back to `index.html` as
  long as there's no `404.html`.
- **Start page address:** Cloudflare drops `.html` from page addresses, so the start
  page lives at `/demo`. `serve.mjs` maps it the same way locally.
- **Response headers** (`_headers`, written by `assemble.mjs`): every response
  forbids framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), content-type
  guessing (`nosniff`), referrers, search indexing, and camera, microphone and
  location access. The `.wasm` and `.data` files get explicit content types.
- **Cost:** the deploy is static assets only, with no Worker script, and every `/api`
  request is answered in the visitor's browser, so traffic is plain file serving. Keep
  it that way: Worker code, or `run_worker_first`, would make requests count against
  the Workers quota.
- **Front door:** `/` always redirects to `/demo`, through the site's `_redirects`
  (written by `assemble.mjs`), `serve.mjs` locally, and `boot.js` as a fallback. That
  holds even when the demo is already set up. From the start page, Continue opens
  `/home`, where the app's guard sends a logged-out visitor to `/login`.

## How it works

- **The API is the production code.** `demo-app.ts` builds the same `ApiModule`
  (every controller, guard, Cedar policy and service). A handful of providers are
  swapped at seams that already exist:

  | Production | Demo |
  |---|---|
  | Postgres | PGlite (Postgres 18 in WebAssembly), persisted in IndexedDB |
  | `PrismaService` | the same schema, generated as a Rust-free client on a PGlite driver adapter |
  | `QueueService` (pg-boss) | `DemoQueueService`: jobs are dropped (no worker, so no email or sync) |
  | `PasswordService` (native argon2) | `DemoPasswordService`: argon2id in WebAssembly, same hash format |
  | `STORAGE_PORT` | `MemoryStorageAdapter` |

- **A service worker is the server.** `sw.ts` answers every `/api/*` request.
  `dispatch.ts` turns the fetch `Request` into a Node-style request, runs it through the
  app's Express instance, and streams the response back, so SSE works too. The
  browser ignores `Set-Cookie` from a service worker, so the worker keeps the cookie jar
  and mirrors the CSRF cookie to the page (`boot.js`).
- **Node built-ins** come from jspm's browser polyfills. `shims/` covers what they lack or
  get wrong: `http`, `crypto` additions, `net`, `perf_hooks`, `async_hooks`, `Buffer`
  `base64url`, and the Cedar web build. Server-only packages the demo never calls
  (S3, SMTP, the Discord socket) resolve to `shims/unavailable.cjs`.
- **The data is made by the real API.** `node-server.ts` applies the real migrations to
  a PGlite database, serves the demo composition over HTTP, runs `api/scripts/seed.mjs`
  against it, and saves the database as `demo-db.tar.gz`. On a first visit, the worker
  loads that snapshot.

## Why it doesn't drift

Every request runs the current controllers, services, Cedar policies, SQL and triggers.
The only demo-specific code is the provider swaps above and the Node shims, which emulate
Node, not Patrice. Two things keep it honest:

- **Build failures:** if the API starts importing a server-only module outside a seam, the
  bundle fails to resolve it or the demo fails at runtime, and CI catches either one.
- **Seed coverage:** the seed runs through the API's validation, so a stale seed fails
  the build. That's how this spike found `api/scripts/seed.mjs` was broken: teams now need a
  division, and tasks need a template. It's fixed here.

## Spike results (2026-11-10)

- **Works in Chromium:** login, home, the task list, the division page (stats and status
  chart), admin, and a write (claim, with CSRF). The status-history trigger fired, the
  session survives a reload, and no API call failed (`tests/demo-spike.mjs`).
- **Startup:** the API is ready about 0.55 s after the first request on a fresh visit,
  and answers in about 10 ms after that.
- **Download, first visit:** about 12 MB (brotli), then cached. That is the worker
  scripts plus Cedar about 2.4 MB, `pglite.wasm` 2.8 MB, `pglite.data` 1.2 MB, the
  Prisma engine 0.7 MB, and the snapshot 5.0 MB. Every file is under Cloudflare's
  25 MiB limit.

## Robustness (second pass, 2026-11-10)

- **One database per build.** The worker names its IndexedDB database after a hash of
  the build's snapshot and deletes older ones. A returning visitor after a deploy
  starts fresh (and logs in again). Without this, a new API would run against the old
  schema, and an old worker still alive during the update would write the same database.
- **Durable writes.** `relaxedDurability` is off, so a write reaches IndexedDB before
  it answers, and a worker the browser stops (about 30 s idle) can't leave a torn
  database. That costs some speed: the stress run's browsing phase went from about
  12 s to about 23 s.
- **Boot can't spin forever.** A hard reload (Ctrl+Shift+R) loads the page without a
  controller, so the page now asks the active worker to claim it. A failed boot is
  retried. After 30 s without an answer, the bar says so.
- **Reset:** `/?reset-demo` unregisters the worker and deletes the demo's database,
  session and cache.
- **Checks** (`tests/`):
  - `demo-stress.mjs`: parallel writes, forced worker restarts (including mid-write),
    45 s idle, reloads, hard reloads, return visit.
  - `demo-sweep.mjs`: every GET route plus common writes through the worker.
  - `demo-upgrade.mjs`: a redeploy for a returning visitor.
- **Single connection:** PGlite is one connection, so a query outside an open
  transaction would wait for it. The e2e suite passes on Postgres with
  `connection_limit=1`, so no current code path does that. Re-run the suite that way
  to keep it true.

### Firefox with DevTools open during load (open question)

Reported: in Firefox, opening DevTools while the demo is starting can leave the
"Starting…" bar up. Letting it settle first, then pressing F12, is fine.

- **No reproduction so far, in either Firefox:** Playwright's Firefox 151 and the
  installed Firefox 159 both start fine with the toolbox open from the start (Network
  panel, Debugger panel, "Disable cache", pause on caught exceptions) and across reloads.
  Opening it at an exact moment mid-boot couldn't be automated.
- **The actual error** (reported from Firefox): `ServiceWorker script at …/sw.js threw an
  exception during script evaluation`. The worker never started, so the boot bar
  waited.
- **Likely cause, now removed:** the bundle compiled Cedar's 4 MB WebAssembly
  synchronously while the script was evaluated, from bytes embedded as base64 in an
  11 MB script with a 17 MB source map. With the debugger attached, Firefox handles all
  of that differently. Cedar now loads asynchronously during boot (the stage "loading
  the policy engine") from `cedar_wasm_bg.wasm`. The script is 5.5 MB, and source maps
  build only with `DEMO_DEBUG=1`.
- **Contained if it happens again:** `sw.js` is now a 2 KB classic-script wrapper that
  owns the worker's listeners and loads the API bundle (`sw-main.js`) with
  `importScripts` inside a `try`. If the bundle throws, `/api` answers 503 with the real
  exception, the boot bar shows it, and the next request retries the load. A classic
  worker also doesn't need module-worker support.
- **Diagnosable now:** the bar and the console show each boot stage, from the page
  (`registering`, `waiting for the service worker`, `waiting for the API`) and from the
  worker (`checking saved database`, `downloading demo data`, `loading demo data into
  the database`, `starting the API`, `API ready`). A stall now says where it stopped.

## Known gaps / next steps

- **Adapter patch:** `pglite-prisma-adapter@0.6` lacks `uuid[]`, and `make.mjs` patches
  it in `demo/node_modules`. Upstream the fix, or move to Prisma 7 and adapter 0.7, which
  needs the Prisma upgrade.
- **Snapshot size:** the snapshot is the largest file. Shipping migrations plus a data
  dump instead would cut about 4 MB, at the cost of about 1.5 s at first boot.
- **Uploads:** attachment uploads spool to a temp file (`hashing-temp-storage.ts`, using
  `fs`), so they fail in the demo. Either add a memory spool behind a seam, or hide
  uploads in demo mode.
- **Login and switching users:** the demo header (docs/plans/browser-demo-header.md)
  will show who you are and switch between demo users.
- **Browser support:** module service workers work in Chromium. Firefox and Safari still
  need testing. The built-in browser pane in the Claude app can't register service
  workers, so test in a real browser.
- **CI:** run `npm run build`, `npm run check:isolation` and the Playwright checks on
  every PR to `main`.
- **Not in the demo:** email, Discord, and background jobs (garbage collection,
  integration sync).
