# ADR 0006 — Discord OAuth client credentials live in runtime config, not env

- **Status:** Accepted
- **Date:** 2026-06-26
- **Context slice:** Discord sign-in (ADR 0005) — credential custody

## Context

ARCHITECTURE §2.8 places "External auth: Google OAuth client id / secret / redirect" in
**Startup config** (env, never in the DB). For Discord sign-in we want an operator to
configure the OAuth app from the admin UI **without redeploying** — so the credentials must
be runtime config. The complication: the OAuth flow runs in the **api role**, which by design
holds **no cipher key** (the bot-token `SecretCipherPort` key is worker-only, ADR 0004), so we
can't reuse that machinery to protect the client secret at rest.

## Decision

Move the Discord OAuth **client id** and **client secret** into `organization.settings`
(runtime config, admin-editable):

- The **client id** is not secret (it's in the authorize URL) — stored and shown plainly.
- The **client secret** is encrypted at rest with **AES-256-GCM under a key derived (HKDF,
  fixed label) from `SESSION_SECRET`** — which the api role already holds (it signs sessions
  and OAuth state). Tagged `oauthsec:`. This needs **no new env** and **no worker round-trip**.
  It is **never returned** by any read: `GET /config` exposes only `discordOAuthConfigured:
  boolean`.
- The **redirect URI** stays derived from `PUBLIC_BASE_URL` (env) — it's infrastructure, not a
  secret.
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` are **removed from the env schema**; any a
  deployment still sets are ignored.

## Consequences

- This **narrows** §2.8: the Discord OAuth client secret is no longer startup config. (Google,
  if/when built, can follow the same pattern or stay env — not decided here.)
- A stolen DB/backup alone never yields the secret — it also needs `SESSION_SECRET` (env). A
  compromised api process has both, which is acceptable: that process already performs the
  OAuth exchange, so it must be able to use the secret regardless.
- **Distinct from the bot token** (ADR 0004): different role (api vs worker), different key
  (`SESSION_SECRET`-derived vs `INTEGRATION_TOKEN_KEY`), different lifecycle. The bot token is a
  long-lived *provider* secret pushed to Discord on every call; the OAuth secret is an
  *app-identity* secret used only during sign-in.
- **Rotation:** rotating `SESSION_SECRET` makes the stored handle undecryptable; Discord
  sign-in reads as "not configured" and the admin re-enters the secret (rare, low-cost).
