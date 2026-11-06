# Patrice architecture

How Patrice is built after the redesign (`docs/redesign-plan.md`, Phases 0–8). This is
the current description; the four review documents from before the redesign
(`current-architecture.md`, `current-design-decisions.md`, `current-design-problems.md`,
`intent-vs-reality.md`) are kept as history. Decisions are recorded as ADRs in
[`docs/adr/`](adr/) (0007 onwards; 0001–0006 are in `docs/old/adr/`). The vocabulary is
in [`UBIQUITOUS_LANGUAGE.md`](../UBIQUITOUS_LANGUAGE.md).

## 1. Shape

| Part | What it is |
|---|---|
| `api/` | NestJS + Prisma on Postgres. One codebase, two processes (§2). |
| `web/` | Angular SPA, served by nginx; talks to `/api/*` only. |
| Postgres | The only datastore: domain data, the job queue (pg-boss), sessions. |
| Object storage | Attachment blobs: S3-compatible, or local disk for single-host installs. |
| Discord | Optional integration: sign-in, role and membership sync, a Gateway socket. |

```
browser ──► nginx (web) ──/api/*──► API process ──┐
                                                   ├── Postgres (data + pg-boss)
                     worker process ───────────────┤
                         └── Discord Gateway + REST └── object storage
```

## 2. Processes (ADR 0017)

`PROCESS_ROLE` picks a root module in `main.ts`:

- **`ApiModule`**: the HTTP pipeline (session → authenticate → authorize guards, the error
  filter) over the shared `CoreModule`. It **publishes** jobs but never consumes a queue,
  runs a schedule, sends mail or opens a Gateway socket. `test/process-topology.e2e-spec.ts`
  holds it to that.
- **`WorkerModule`**: `CoreModule` plus everything that runs on its own: the `JobRunner`
  (queue consumers and cron schedules), email, bootstrap mode, the token vault, the sync
  engine and the Discord Gateway. Run **one** worker.
- Unset: `AppModule` imports both, for development and tests.

**Jobs** (`api/src/queue/job-queues.ts`) each have a retry policy and, except the token
hand-off, a dead-letter queue (`GET /jobs/dead-letters`, `job:read`). Publishing fails
loudly: if pg-boss is down the caller gets `503 QUEUE_UNAVAILABLE` and `/health` reports
`degraded`. Schedules: `events.deliver` every minute, `integration.reconcile-floor` every
30 minutes, `gc.sweep` hourly. In tests the queue runs in `sync` mode: a publish runs the
queue's due jobs in-process before returning.

## 3. Modules and layers

- **Domain layer** (`src/domain/`): aggregates with their invariants (e.g. `Division`),
  version-guarded repositories, and a `UnitOfWork` that writes audit rows and bumps
  `config_version` in the same transaction.
- **Feature modules**: auth and accounts, invitations, roles, divisions, teams,
  membership, grants, users, request templates, tasks, submissions, messages, attachments,
  notifications, activity, GC, integrations.
- **Contract** (`src/contract/`): every route is declared once with Zod schemas
  (`routes.ts`, `schemas.ts`). `npm run contract:emit` writes `api/openapi.json` and the
  web's generated types (`web/src/app/core/api/schema.d.ts`); a unit test fails if either
  drifts. In tests every response is checked against its schema.
- **Errors**: one catalog (`src/common/error-codes.ts`) of codes with fixed statuses,
  exported in the contract.

## 4. Identity and access

- **Users and identities**: a User has one or more sign-in identities (password, Google,
  Discord). Sessions are opaque, server-side, revocable (`/me/sessions`). Accounts are
  self-service: password, email change (confirmed from the new address), providers.
- **Membership is not authority** (ADR 0007): belonging to a division or team is a
  `membership` row. Teams belong to exactly one division. Authority comes only from
  **Roles** holding **Grants** (action × scope × effect).
- **Cedar decides** every access question. Grants are projected to Cedar policies (cached
  per `config_version`); one `EntityLoader` builds every resource. Lists are filtered per
  row, and responses carry `allowedActions` so the web never guesses. Static policies add
  baseline self-access, the self-review forbid, the `requireDiscordLink` forbid (ADR 0012)
  and the custom-template permit (ADR 0010).
- **The admin floor**: any change that could remove authority (a grant, a role, a revoke
  by sync) runs under `withAdminFloor`, which evaluates the governance actions in Cedar
  against the transaction's state and refuses (`409 LAST_ADMIN`) if no effective admin
  would remain.
- **Seeded roles** (ADR 0016): Admin holds every action globally (topped up when actions
  are added). Member holds the starter grants and is pre-assigned to invitations; an
  upgraded install gives it to everyone already there.

## 5. Work

- **Request templates** (ADR 0010): a division keeps a library of templates, at most one
  the default. Creating a task picks a library template, the default, or **custom**
  questions (allowed by the division's `allowCustomTemplates` or a `task:compose_template`
  grant). The task keeps its own snapshot (`task_question`); answers point at the
  snapshot, so editing or deleting a library template never touches existing work.
- **Seats** (ADR 0011): a claimant can't leave once they've submitted; retiring a
  submission removes the claimant and opens the seat; rejection keeps the seat with no
  resubmit; eviction is always allowed and turns the evictee's submissions into rejected
  records. Only submissions from a claimant's current tenure count.
- **Status** (ADR 0008): `deriveStatus` is the one pure rule. Completion is a recorded
  fact (`completed_at`, `completed_by`), terminal, closes claims and marks outstanding
  submissions `not_required`. `status_cache` is stored for filtering and can be rebuilt
  from facts (`TaskStatusService.rebuild`).
- **Attachments**: uploads stream to a temp file with an incremental hash, then to
  storage. An upload belongs to a message, or is **pending** on a task until its
  uploader's own submit claims it for an answer; unclaimed pending uploads are collected
  after a day. The answer validator is shared with the web (copied by
  `contract:emit`, drift-tested).

## 6. Events, audit, lifecycle

- **One event stream** (ADR 0009): commands record typed `domain_event`s in their
  transaction. A task's events are its **timeline** (`GET /tasks/:id/timeline`); an
  event's snapshotted recipients become **notifications**, delivered after commit and
  again by the minute job (idempotent per event and recipient). Messages are comments
  only.
- **Audit** (`activity`, ADR 0015): append-only, IDs and configuration values only;
  user-authored text is referenced by id.
- **Lifecycle** (ADR 0014): tasks, users, divisions, teams, roles and integration
  connections retire → grace → revive → GC. Grants, messages, attachments and library
  templates are deleted outright with an audit row. GC scrubs history-bearing users in
  place and deletes the rest.

## 7. Discord integration

- **Sync** (ADR 0013, 0018): the `SyncEngine` is provider-neutral and talks to the provider
  through `IntegrationSyncPort` (the Discord adapter does I/O only). The pure reconciler
  decides changes for each mapping (inbound, outbound or bidirectional) to a role, a
  division membership or a team membership. Outbound pushes go first; then each user's
  Patrice-side changes and settled baseline land in one transaction, so a failed push
  never corrupts the baseline. Cold conflicts break by the later change, then by the
  mapping's winner.
- **Triggers**: Gateway member events (per-user syncs), admin changes (signalled to the
  worker), and the reconcile floor (`RECONCILE_FLOOR_MS`, one hour since `last_sync_at`;
  the API reports `nextReconcileAt` from the same value).
- **Sync links** are created wherever Patrice knows a member's Discord id: registration
  through Discord, connecting Discord to an account, and for everyone known when a
  connection is added.
- **When grants lose their source** (ADR 0013): deleting a mapping or retiring a connection
  keeps what it granted as native grants (default) or revokes it, under the admin floor;
  a retired connection's choice is applied when it's collected.
- **Bot tokens** (ADR 0018): AES-256-GCM under a key only the worker holds; the API hands
  new tokens over in a job whose data the worker wipes.

## 8. Web client

Per-area services (`web/src/app/core/api/*.api.ts`) return Observables over a typed client
generated from the contract; there are no hand-written API types. Controls follow
`allowedActions`; names come from the read endpoints every member may call. The visual
language is the "graphite sheet" (`web/DESIGN.md`).

**Admin editors stage every change until Save.** Permissions (`POST /grants/batch`) and
memberships (`POST /memberships/batch`) save all-or-nothing; the other tabs apply their
staged changes in order, each version-checked (`STALE_VERSION`; settings compare the
values they replace), stopping at the first refusal and saying how many landed. While a
tab holds unsaved changes the shell announces it (`POST /admin/presence`, repeated every
20 s); the API relays an `admin-presence` event on the notification stream to the other
people who may view that page, who see a bar naming the editor, and a Reload once they
save. Presence is never stored.

## 9. Operations

- **Deploy**: `deploy/docker-compose.prod.yml`: `migrate` (one-shot) → `api` + `worker` →
  `web`. The bot-token key goes in `worker.env` only.
- **Cutover**: `api/scripts/cutover-snapshot.mjs` snapshots counts, task statuses and
  per-user visibility before and after a migration; see
  [`cutover-rehearsal.md`](cutover-rehearsal.md).
- **Tests**: unit (`npm test`), e2e against Postgres with pg-boss in sync mode and an
  in-memory Discord port (`npm run test:e2e`), web unit tests and build.
