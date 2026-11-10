# Browser demo (spike)

A static build of Patrice that runs **the real API inside the visitor's browser**, so it
can be hosted on Cloudflare Pages (or any static host) with no server, no database and
nothing to secure. Each visitor gets their own copy of the data, kept in their browser.

```bash
npm run demo:build     # ~30 s → demo/site
npm run demo:serve     # http://localhost:4400 (a plain static server)
```

Log in as `admin@example.com` / `correct horse battery` (the dev seed's users).

**Start page (`demo.html`).** A visitor without the demo set up (no service worker
registered) is sent there from any app URL, with `?next=` holding where they were going.
The page:

- explains the demo;
- shows whether this browser holds demo data, and how much;
- **Start / Continue:** installs the worker and starts the API, ticking off each stage
  the worker reports, then opens the app;
- **Clear demo data:** asks the worker to close its database, unregisters it, and
  deletes the database, cache and cookies.

The demo login is read from `scripts/seed.mjs` at assembly and set as
`window.patriceDemo`. The start page and the login form show it, the form next to its
labels; outside the demo the global is absent and the form is unchanged.
`/?reset-demo` now leads to this page.

## Hosting

Deploy the **whole** `demo/site/` folder (42 files) to the **root** of an address,
such as a subdomain. The app, the worker and the API all use root paths (`/sw.js`,
`/api/…`, `/login`).

- **Cloudflare Workers (static assets):** run `npm run demo:deploy`, which uses
  `demo/wrangler.jsonc`. That config turns on `not_found_handling:
  "single-page-application"`; without it, app routes like `/login` return 404.
- **Cloudflare Pages:** upload the folder; app routes fall back to `index.html` as
  long as there's no `404.html`.
- **Start page address:** Cloudflare drops `.html` from page addresses, so the start
  page lives at `/demo`. `serve.mjs` maps it the same way locally.
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
  a PGlite database, serves the demo composition over HTTP, runs `scripts/seed.mjs`
  against it, and saves the database as `demo-db.tar.gz`. On a first visit, the worker
  loads that snapshot.

## Why it doesn't drift

Every request runs the current controllers, services, Cedar policies, SQL and triggers.
The only demo-specific code is the provider swaps above and the Node shims, which emulate
Node, not Patrice. Two things keep it honest:

- **Build failures:** if the API starts importing a server-only module outside a seam, the
  bundle fails to resolve it or the demo fails at runtime, and CI catches either one.
- **Seed coverage:** the seed runs through the API's validation, so a stale seed fails
  the build. That's how this spike found `scripts/seed.mjs` was broken: teams now need a
  division, and tasks need a template. It's fixed here.

## Spike results (2026-11-10)

- **Works in Chromium:** login, home, the task list, the division page (stats and status
  chart), admin, and a write (claim, with CSRF). The status-history trigger fired, the
  session survives a reload, and no API call failed (`web/tools/shots/demo-spike.mjs`).
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
- **Checks** (`web/tools/shots/`):
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
  it in `node_modules`. Upstream the fix, or move to Prisma 7 and adapter 0.7, which
  needs the Prisma upgrade.
- **Snapshot size:** the snapshot is the largest file. Shipping migrations plus a data
  dump instead would cut about 4 MB, at the cost of about 1.5 s at first boot.
- **Uploads:** attachment uploads spool to a temp file (`hashing-temp-storage.ts`, using
  `fs`), so they fail in the demo. Either add a memory spool behind a seam, or hide
  uploads in demo mode.
- **Login:** a demo banner should show the login, or the demo should log in automatically.
  It also needs a "Reset demo" control that deletes the IndexedDB database and the jar.
- **Browser support:** module service workers work in Chromium. Firefox and Safari still
  need testing. The built-in browser pane in the Claude app can't register service
  workers, so test in a real browser.
- **CI:** run `npm run demo:build` and the Playwright check on every PR to `main`.
- **Not in the demo:** email, Discord, and background jobs (garbage collection,
  integration sync).
