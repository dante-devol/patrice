# Plan: browser demo — own project, demo header, user switcher, inbox

Status: agreed with the owner 2026-11-10. **Phase 1 done** (the demo is now `demo/`;
see `demo/README.md`); phases 2–5 not started. Seed data is being designed separately
(see "Inputs").

## Goals

1. **Strictly demo-only.** Nothing in `api/` or `web/` knows the demo exists. The demo
   is its own top-level project that consumes the API source and the web build.
2. **A demo header** on every demo page:
   - a back link to https://dante-devol.dev (same tab);
   - a link to the demo start page (`/demo`);
   - a **user switcher**;
   - an **inbox**.
   Before the demo is started, it shows only the back link.
3. **The user switcher** moves between demo users, invitees, and "Anonymous" (no
   account, logged out). It demonstrates the app's behaviour and never corrects it:
   whatever the app does for a user, the demo shows.
4. **The inbox** works like a single-user mail client in the style of Mailpit. It shows
   the mail of whoever the switcher says you are.
5. **Stretch:** a faked Discord *connected server*, with role mappings and an audit log
   of what the sync would have done.

Out of scope: emailing invitations (Patrice doesn't, and the demo won't invent it);
a reset control in the header (the start page has Clear).

## Inputs

- **`personas.json`**, from the demo seed being built separately: each user's `key`,
  `email`, `password`, `label` and a one-line `description`. Until it exists, a
  stand-in is built from the current dev seed's users (admin, Devin, Maya, Aric, Sela,
  Joon).

## Design

### Project layout (phase 1)

```
demo/
  package.json        own deps: pglite, pglite-prisma-adapter, hash-wasm, esbuild,
                      @jspm/core, playwright (wrangler runs through npx)
  src/                composition root, dispatcher, shims, service worker
  web/                served as-is: start page (demo.html), boot script, worker
                      wrapper (sw.js); the header goes here (phase 2)
  tests/              Playwright checks
  scripts/            make, build, assemble, serve, check-isolation, diagnostics/
  .build/             everything generated (ignored)
  wrangler.jsonc
```

- **Prisma client:** the demo build writes a temporary copy of
  `api/prisma/schema.prisma` with the demo generator block swapped in, and generates
  from that. The real schema loses its `demo` generator.
- **Compiling the API:** `api/src` is still compiled with tsc, which keeps Nest's
  decorator metadata. The compiled code resolves its packages from `api/node_modules`:
  through esbuild's `nodePaths` when bundling, and `NODE_PATH` for the Node snapshot
  step. **This is the main risk in phase 1;** prove it before moving anything else.
- **Removed from `api/` and `web/`:**
  - the demo dependencies and `demo:*` scripts in `api/package.json`;
  - the schema generator block;
  - the demo entries in `.gitignore` and the ESLint ignores;
  - the `window.patriceDemo` login hint in `login.component.ts`. The header replaces it.
- **VS Code tasks** point at `demo/`.
- **Isolation check:** `demo/scripts/check-isolation.mjs` fails if `api/` or `web/`
  reference the demo (imports of `demo/`, `patriceDemo`, `__demo`). It runs as part of
  `demo:build`, and as an npm script for CI.

### Demo endpoints (phase 2 onward)

The header talks to the service worker at **`/__demo/*`**. The worker answers these
itself, before anything reaches Nest, so the API has no such routes.

| Endpoint | Purpose |
|---|---|
| `GET /__demo/state` | Started or not; the current user (from the real session); the switcher list; unread count |
| `POST /__demo/switch` | Switch to `{ key }` (persona, invitee or `anonymous`) |
| `GET /__demo/inbox` | The current user's messages (list) |
| `GET /__demo/inbox/:id` | One message, marked read |

If the worker isn't running (the demo isn't started), Cloudflare answers `/__demo/*`
with `index.html`. The header treats any non-JSON answer as "not started".

### Header (phase 2)

- **Delivery:** a standalone script and stylesheet in `demo/site/header/`. The build
  injects them into `index.html` and `demo.html`; the Angular source is untouched.
- **Styling:** rendered in a **Shadow DOM**, so the app's global CSS and the header's
  styles can't affect each other. It uses the app's graphite tokens.
- **Layout:** a fixed bar about 40 px tall. It pushes the page down by the same amount.
  Check that app overlays (dialogs, toasts, the admin presence bar) still sit correctly
  below it.
- **Contents:**
  - left: "← dante-devol.dev", then "Patrice demo";
  - right: "Start page", the user switcher, and the inbox button with an unread badge.
- **On `/demo` before the demo is started:** only the back link shows; the switcher,
  inbox and start-page link are hidden. Once started, the header looks the same on
  `/demo` as in the app.

### User switcher (phase 3)

- **The list** is a superset:
  - the users in `personas.json`;
  - **invitees**: pending invitations for a specific email (not revoked, not expired,
    uses left), read from the database. Invitations without an email are left out;
  - users who **accepted an invitation during the demo**, under their own name;
  - **Anonymous**.
- **The current user** is whoever the real session belongs to, not what the switcher
  last chose. If you log out or log in through the app, the header follows.
- **Switching** goes through the app's real endpoints, so every rule the app has
  applies. Nothing is bypassed:
  - **to a member:** the worker posts the user's email and password to the real
    `POST /api/auth/login`. If the app refuses (a retired user, a password changed
    during the demo), the header shows the app's message and leaves you where you were;
  - **to Anonymous or an invitee:** the real `POST /api/auth/logout`. An invitee has no
    account, so they're logged out, with their (empty) inbox;
  - **invitees who accept:** when an invitation is redeemed, the worker remembers the
    email and password from that request as it passes through. The entry then logs in
    as the new account;
  - **afterwards:** the page reloads at `/home`, so nothing stale stays on screen. The
    app's guard sends Anonymous to the login page.
- **Storage:** the switcher's own data (remembered passwords for accepted invitations)
  sits in a demo-only IndexedDB store named for the build, outside Patrice's database.
  The start page's Clear removes it.

### Inbox (phase 4)

- **Running the mail jobs:** the demo queue runs `auth.mail` jobs in the worker
  through the real `AuthMailWorker` handler, instead of dropping them.
- **Capturing mail:** a `DemoEmailService` replaces the real `EmailService`'s Nodemailer
  transport with one that stores each message in the demo mail store: to, from,
  subject, text, HTML, time, and the user it's for. Messages are built by the real
  templates, so the inbox shows exactly what Patrice would send. No SMTP code is
  bundled.
- **Which mail is "yours":** messages addressed to the current user's email, plus an
  email-change confirmation sent to their new address (matched by the job's user).
  Anonymous has no mailbox.
- **UI:** a panel under the header, like Mailpit:
  - a list of sender, subject, time, with unread messages in bold;
  - the selected message shown in a sandboxed iframe (`srcdoc`, no scripts) that may
    navigate the top page when a link is clicked, so "verify email" or "reset password"
    opens the real page in the demo;
  - a text view for messages without HTML.
- **The mail Patrice sends today:** email verification, password reset, and email
  change confirmation. A password-reset request made as Anonymous lands in that user's
  inbox, and reading it means switching to them, which logs you in as them. That is the
  single-user model working as intended, so it's worth a line in the panel's empty
  state.

### Connected Discord server (phase 5, stretch)

- **Fake Discord:** a stand-in for the integration sync port that records what the sync
  would do on Discord, modelled on `test/fake-sync-port.ts`.
- **Seed:** a connection and role mappings. Coordinate with the seed work.
- **Sync:** run `integration.sync` jobs in the worker. The Gateway stays off.
- **Header:** a "Discord" panel listing the audit log ("added role Writing Lead to
  Maya"). Admin > Integrations shows the connected server through the real UI.
- Scope this when phase 4 is done; it may need more seams than it looks.

## Phases

Each phase ends with its Playwright check passing (in `demo/tests`) and is committed
separately.

| # | Phase | Done when |
|---|---|---|
| 1 | Move `api/demo` to `demo/`; remove demo hooks from `api/` and `web/`; isolation check | `demo:build` and deploy work from `demo/`; the existing demo checks pass; the API and web builds and tests pass; the isolation check passes |
| 2 | Header shell and `/__demo/state` | The header shows on the app and `/demo`; before start only the back link; overlays still fit |
| 3 | User switcher | Every persona, Anonymous, a new invitee, and that invitee after accepting can be switched to; a retired user is refused with the app's message |
| 4 | Inbox | Verification, reset and email-change mail appear in the right inbox; their links work |
| 5 | Discord (stretch) | The audit log reflects role changes made in the app |

## Risks and open items

- **Phase 1 resolution:** compiled API code must find packages in `api/node_modules`
  from `demo/`. Prove this first.
- **Header overlap:** a fixed header may collide with the app's own fixed or sticky
  elements. Phase 2 checks the admin pages, dialogs and toasts.
- **Personas file:** its format needs agreeing with the seed work. Phases 1–2 don't
  depend on it, and phase 3 uses the stand-in until it lands.
- **Firefox:** the start-up problem with DevTools open is still unresolved (see
  `demo/README.md`). It isn't blocked by this work.
