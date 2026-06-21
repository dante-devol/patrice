# Tasks UI — visual verification (Playwright)

A deliberately small, **non-CI** screenshot utility for eyeballing the ui-tailwind
Tasks pages without standing up the API / Postgres / auth stack. It drives a running
`ng serve` with Playwright and mocks every `/api/*` call with representative data.

## Run

```sh
# terminal A
cd web && npm start

# terminal B (once :4200 is up)
cd web && node tools/screenshot-tasks.mjs
```

Writes `tools/screenshots/{tasks-overview,tasks-overview-create,task-detail}.png`.

## Scope (kept intentionally narrow)

- One script, three full-page screenshots — **not** an e2e suite, not wired into CI.
- The mock data mirrors the design spike (the five divisions, a multi-claim Writing
  task, the single-claim norms across every status).

## CI note

`playwright` is a `devDependency`, and `npm ci` runs its post-install browser
download. The CI `web` job never runs this script, so before committing the dep,
either (a) keep this tooling out of the CI-installed manifest, or (b) set
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` on the web job's install step. Browsers used
here were fetched once via `npx playwright install chromium`.
