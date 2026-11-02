# ADR 0005 — Discord is a first-class auth provider, separate from the integration link

- **Status:** Accepted
- **Date:** 2026-06-26
- **Context slice:** Discord integration — "log in with Discord" (account linking + login)

## Context

ARCHITECTURE §2.2 names Discord login a "possible future method, not a v1 requirement,"
and the `external_identity` table comment states it is "an integration link only — **never**
an authentication path; `user_identity` is the sole auth path." The product now wants users
to **log in using Discord** (as the design always anticipated for Google) and to manage
**their own** Discord connection, while admins separately own role↔role mapping. Conflating
the two — letting `external_identity` double as a login credential — would couple
authentication to integration machinery, which §2.2 forbids ("auth never depends on any
integration"), and would make login break whenever a guild connection is retired.

## Decision

Discord becomes a real **`AuthProvider`/`AuthMethod`**, materialised as a
`user_identity[provider=discord, providerSubject=<discord user id>]` row — **distinct** from
the `external_identity` integration link. The two are independent axes with different
drivers:

- **Auth identity** (`user_identity[discord]`) — *user-driven*, connection-independent, uses
  the **app-level** OAuth client (`DISCORD_CLIENT_ID/SECRET`). This is what "log in with
  Discord" authenticates against. One OAuth consent may create both records, but they remain
  separate rows.
- **Integration link** (`external_identity`) — *user-driven to opt in*, but scoped to a
  guild **connection** and consumed by the **bot-token** role-sync path (ADR 0002/0004).
- **Role mapping** (`external_group_mapping`) — *admin-driven* org config, independent of any
  individual user's link.

Account creation stays **invite-only** (§2.2): a Discord login that matches no existing
`user_identity` is **rejected, never auto-provisioned**. A newly *invited* user may register
via "Continue with Discord," which mints the `user_identity[discord]` through the normal
invitation redemption (FCFS, privilege-bounded roles). All Discord OAuth flows
(login / register / link) share **one** redirect URI (`/api/auth/discord/callback`); a
signed, expiring `state` carries the intent.

## Consequences

- Login never depends on an integration connection existing — retiring a guild connection
  removes role sync, not the ability to sign in.
- `(provider, providerSubject)` uniqueness still structurally prevents one Discord account
  attaching to two Patrice users; `(userId, provider)` keeps one Discord sign-in per user.
- OAuth identities are **verified-on-create** (consent proves control), so they bypass the
  email-verification flow; an OAuth-only user has no password identity to "verify."
- This **narrows** the `external_identity` "never an auth path" rule to its literal scope
  (the *integration link* is not an auth path) without weakening it — the auth path is the
  separate `user_identity` row, exactly as §2.2 requires.
