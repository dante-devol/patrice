# Discord Bot — Design Sketch

A backend-only Discord bot that serves the integration's two needs: **role sync**
and **account linking**. No user-facing commands or notifications.

---

## Auth model

The bot runs as a process with two credentials in its environment:

```
DISCORD_BOT_TOKEN=<bot token from Discord developer portal>
PATRICE_BASE_URL=https://your-patrice.example.com
PATRICE_CONNECTION_ID=<integration_connection.id>
```

The bot token is also stored in `integration_connection.config.botToken` so the
Patrice sync adapter can call Discord directly without going through the bot process.

---

## What the bot actually does

### 1. Role sync (outbound: Patrice → Discord)

Called by the Slice 8.4 `DiscordAdapter` when processing an `outbound` or
`bidirectional` mapping. The adapter holds the bot token from `connection.config`
and calls Discord directly — no separate bot process needed for this path:

```
PUT    /guilds/{guildId}/members/{userId}/roles/{roleId}   — grant a Discord role
DELETE /guilds/{guildId}/members/{userId}/roles/{roleId}   — revoke a Discord role
```

The bot application needs the **Manage Roles** permission in the guild, and its
highest role must be above any role it manages (Discord hierarchy rule).

### 2. Guild member fetch (inbound sync: Discord → Patrice)

Already implemented in `DiscordAdapter.fetchGuildMembers`. Paginates:

```
GET /guilds/{guildId}/members?limit=1000&after={cursor}
```

Returns each member's stable user ID + role list. The adapter reconciles this
against `user_role` rows for users with a matching `external_identity`.

### 3. Account linking redirect target

`POST /api/integrations/:id/link` builds the Discord OAuth URL. The bot
application (not the bot process) is the OAuth app registered in the Discord
developer portal — it supplies the `client_id` and `client_secret` that the
Patrice API reads from `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`. No bot
process involvement; this is purely the OAuth credential pair.

---

## Bot application setup (Discord developer portal)

1. Create an application at https://discord.com/developers/applications
2. Under **Bot**: enable **Server Members Intent** (needed for guild member listing)
3. Under **OAuth2 → Redirects**: add `{PUBLIC_BASE_URL}/integrations/{connectionId}/link/callback`
4. Invite the bot to the guild with scopes `bot` + `applications.commands` and
   permission **Manage Roles**
5. Copy the bot token → paste into the "Bot token" field when connecting the guild
   in Admin → Integrations

---

## Gaps to fill (tracked in #46)

| Gap | File |
|---|---|
| Outbound role add/remove calls (`PUT`/`DELETE` guild member role) | `discord.adapter.ts` — stub at the `void roleExistsInGuild` comment |
| Look up Patrice user by Discord snowflake (for future needs) | New query on `external_identity` table — no endpoint needed internally |
