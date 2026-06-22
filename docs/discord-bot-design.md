# Discord Bot — Design Sketch

A support-facing Discord bot that surfaces Patrice task state into a guild, lets
members interact with their tasks from Discord, and keeps role membership in sync.

This is a **design face** — the full list of surfaces to implement. Each section
names the Patrice API endpoint it calls; the bot authenticates as a service account
(a Patrice user whose session token is stored in the bot process's environment).

---

## Auth model

The bot runs as a **dedicated service-account user** registered in Patrice via the
normal invite flow. That user holds a long-lived session (or uses a pre-issued
`AuthToken` if the API adds bot-token support later). The connection between the
guild and the Patrice org is the `integration_connection` row created by an admin
in the Integrations tab; the bot reads its `connectionId` from its own env.

```
PATRICE_BASE_URL=https://your-patrice.example.com
PATRICE_SESSION_COOKIE=<bot service-account session>
PATRICE_CONNECTION_ID=<integration_connection.id>
DISCORD_BOT_TOKEN=<bot token from Discord developer portal>
DISCORD_GUILD_ID=<guild snowflake>
```

---

## Slash commands

### `/task list`

Shows the caller's open or in-progress tasks in an ephemeral embed.

```
GET /api/tasks?claimant=<resolved-patrice-user-id>&status=open,claimed,review,revising
```

Reply: paginated embed (5 tasks per page) with name, status badge, division,
and a "View" button that deep-links to the web UI task page.

---

### `/task view <task-id>`

Fetches and displays a single task as an embed visible to the channel.

```
GET /api/tasks/<id>
GET /api/tasks/<id>/messages   (first page, for context)
```

Embed fields: name · division · openings · status · requester (display-name
resolved via `/api/users/<id>`) · description truncated to 300 chars.

---

### `/task claim <task-id>`

Claims a task on behalf of the invoking user (requires their Discord account to
be linked via `external_identity`).

```
POST /api/tasks/<task-id>/claim
```

Resolves the Discord user → Patrice user via:
```
GET /api/integrations/<connectionId>/links?discordUserId=<snowflake>
```
*(This endpoint doesn't exist yet — see Gaps below.)*

Reply: ephemeral confirmation or error ("Task is full", "Already claimed", etc.).

---

### `/task unclaim <task-id>`

```
POST /api/tasks/<task-id>/leave
```

---

### `/task submit <task-id>`

Opens a Modal with one text input per questionnaire question (up to 5; Discord
modals cap at 5 components). Answers are POSTed on submit.

```
GET  /api/tasks/<task-id>/questionnaire   (to build the modal fields)
POST /api/tasks/<task-id>/submissions     { answers: [...] }
```

Attachments: not supported in the modal flow — the embed reply instructs the
user to attach files via the web UI.

---

### `/task status <task-id>`

Returns the current `statusCache` + latest submission state if one exists, as
an ephemeral embed.

```
GET /api/tasks/<task-id>
GET /api/tasks/<task-id>/submissions (latest)
```

---

### `/link-patrice`

Starts the Discord OAuth account-link flow so the bot can map Discord → Patrice.

```
POST /api/integrations/<connectionId>/link
```

Returns `{ redirectUrl }`. Bot replies with a button linking to that URL.
After the user completes the OAuth callback, their `external_identity` row
is written and future `/task claim` calls resolve them automatically.

---

### `/sync`  *(admin-only, gated by Discord role)*

Manually triggers a membership sync run.

```
POST /api/integrations/<connectionId>/sync
```

Reply: "Sync queued — results will apply within a few minutes."

---

## Event-driven notifications (webhook / SSE bridge)

The bot can optionally bridge Patrice's SSE notification stream to Discord
channel messages. A small worker process subscribes to:

```
GET /api/notifications/stream   (EventSource, bot service-account)
```

On each event the worker posts an embed to a configured `#patrice-updates`
channel:

| Notification type | Embed content |
|---|---|
| `task.claimed` | "@user claimed task **X**" |
| `submission.submitted` | "New submission on **X** awaiting review" |
| `submission.reviewed` (approve) | "**X** approved ✅" |
| `submission.reviewed` (return/reject) | "**X** returned/rejected ⚠️" |
| `task.completed` | "**X** completed 🎉" |

---

## Role sync (bidirectional)

Handled automatically by the Slice 8.4 sync engine on a schedule or via `/sync`.
No additional bot code needed — the adapter drives it via pg-boss.

For **outbound** sync (Patrice → Discord): the adapter calls the Discord API
directly using the bot token stored in `integration_connection.config.botToken`.
This is the stub noted in [#46](https://github.com/dante-devol/patrice/issues/46).

---

## Gaps to fill before the bot is fully functional

| Gap | Where to fix |
|---|---|
| `GET /api/integrations/:id/links?discordUserId=` — look up a Patrice user by their Discord snowflake | New endpoint in `integrations.controller.ts` |
| Outbound sync push (Discord role add/remove) | `discord.adapter.ts` stub (tracked in #46) |
| Bot-token auth / long-lived `AuthToken` for service accounts | Auth system; not in v1 scope |
| Questionnaire modal — only 5 questions fit in a Discord modal | Cap enforced at bot layer; overflow directed to web UI |
| File-attachment answers | Web UI only; Discord modals don't support file inputs |

---

## Recommended bot framework

[discord.js](https://discord.js.org/) v14 (Node 20+). Slash commands registered
via `REST#put(Routes.applicationGuildCommands(...))` on startup. Interaction
handling in a single `interactionCreate` listener with a command map.

The worker and the bot can live in the same process; separate the SSE bridge into
a `BridgeService` class so it can be independently restarted on stream disconnect.
