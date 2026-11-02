# Slice 8 — Integrations (Discord) *(post-v1)*

*Part of the Patrice build plan — read [`00-overview.md`](00-overview.md) for the pinned tech
stack and global conventions. **Depends on:** Slice 1 (auth/engine), Slice 2 (roles), Slice 7
(retirement/GC of links). **This slice is explicitly post-v1 — ship Slices 1–7 first.***

**Goal.** Optional, provider-agnostic external sync: connect a Discord **guild**, link a user's
Discord account, map Patrice **roles ↔ Discord roles**, and **sync** membership — all behind an
isolated adapter on the queue, never touching the auth core.

**Acceptance demo.**
1. Admin connects a Discord guild (`integration_connection`), providing the bot/app credentials (from
   startup config; the connection stores non-secret config).
2. A user links their Discord account (`external_identity`) via OAuth — **separate** from their
   Patrice auth identity.
3. Admin maps a Patrice role to a Discord role (`external_group_mapping`).
4. A sync run reconciles `user_role` from Discord roles (and/or pushes), per the mapping and the
   configured direction/precedence; results and removals are logged to `activity`.

**In scope.** `integration_connection`, `external_identity`, `external_group_mapping` tables; the
**per-provider adapter** consuming a pg-boss queue; Discord OAuth account linking; role↔group mapping
config; the bidirectional sync with **last-write-wins** precedence (`user_role.source`/
`source_connection_id`/`updated_at`); broken-mapping flagging; `activity` sync logging.

> *The `activity` table itself lands in Slice 1 (org-level immutable audit, used by every
> later slice). Slice 8 just **uses** it for sync verbs — `integration.connected`,
> `integration.synced`, `integration.broken`, `integration.removed`, `external_identity.linked`,
> `external_group_mapping.created`/`.updated`/`.retired`.*

## Schema (add)
```
integration_connection  id, organization_id, provider ('discord'|…), external_workspace_id text,
                        display_name, config jsonb, credentials_ref text null (seam; auth delegated to provider),
                        status ('active'|'broken'|'disabled'), lifecycle_state, retired_at, created_at, updated_at
                        UNIQUE(organization_id, provider, external_workspace_id)
external_identity       id, user_id→app_user, connection_id→integration_connection,
                        external_user_id text, external_handle text null, linked_at, last_synced_at
                        UNIQUE(connection_id, external_user_id), UNIQUE(user_id, connection_id)
external_group_mapping  id, role_id→role, connection_id→integration_connection, external_group_id text,
                        sync_direction ('inbound'|'outbound'|'bidirectional'), is_broken bool default false,
                        created_at, updated_at
                        UNIQUE(role_id, connection_id, external_group_id)
```

## Sync engine (queue-driven)
- The **adapter** runs only from pg-boss jobs (never inline in API requests), so it's isolated and
  resilient to provider outages. On a sync tick (or webhook), reconcile `user_role` against mapped
  Discord roles per `sync_direction`; resolve conflicts by **LWW timestamp** (`updated_at`, `source`).
  Map by **stable IDs** (Discord role/guild snowflakes), surviving renames; flag `is_broken` if a
  mapped group is deleted. Log changes + removals to `activity` (`source='integration'`,
  `source_connection_id`).
- **Auth stays untouched:** `external_identity` is purely an integration link; it is **never** an
  authentication path (that remains `user_identity`).

## API endpoints
```
POST  /integrations                         (integration:create)  -- connect a guild
PATCH /integrations/:id                      (integration:update)
POST  /integrations/:id/retire               (integration:retire)
GET   /integrations
POST  /integrations/:id/link                 -- start Discord OAuth account-link for the current user
POST  /integrations/:id/mappings             (role↔group mapping CRUD)
POST  /integrations/:id/sync                 -- enqueue a sync run
```
*(Add `integration:create|update|retire|revive` to the action vocabulary/engine — matching the
revive-as-distinct-action convention from Slice 2.)*

## Web (Angular)
- Admin **Integrations** area: connect/disconnect, manage role↔group mappings, trigger/inspect sync,
  broken-mapping warnings. A per-user "Link Discord" affordance in profile settings.

## Tests
- Connect/link/map round-trips; mapping by stable ID survives a rename; deleted group → `is_broken`.
- Sync reconciles `user_role` per direction; LWW resolves conflicts; removals logged to `activity`.
- Auth is unaffected by integration state (login works with no/broken integration).
- Retiring a connection/link is handled by the Slice-7 GC.

**Done when** the demo passes — an org can connect Discord and sync roles without any impact on the
auth/identity core.
