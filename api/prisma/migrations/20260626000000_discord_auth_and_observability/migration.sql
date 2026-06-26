-- Discord auth provider + integration observability
--
-- 1. Discord becomes a first-class auth provider/method (user_identity[discord]),
--    independent of the external_identity integration link (api/CONTEXT.md).
-- 2. Avatar hash captured on link (#52).
-- 3. Gateway + sync lifecycle persisted on the connection so admins can see health,
--    next reconcile, and last sync result without reading server logs.

-- ── 1. Discord as an auth provider/method ──────────────────────────────────
-- PG 12+ allows ADD VALUE inside a transaction as long as the new value is not
-- used in the same transaction (it isn't — no rows reference it here).
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'discord';
ALTER TYPE "AuthMethod"   ADD VALUE IF NOT EXISTS 'discord';

-- ── 2. Avatar hash on the integration link (#52) ───────────────────────────
ALTER TABLE "external_identity"
  ADD COLUMN "external_avatar_hash" TEXT;

-- ── 3. Gateway + sync observability on the connection ──────────────────────
CREATE TYPE "GatewayState" AS ENUM ('down', 'connecting', 'connected', 'degraded');
CREATE TYPE "SyncState"    AS ENUM ('idle', 'queued', 'running');

ALTER TABLE "integration_connection"
  ADD COLUMN "gateway_state"             "GatewayState" NOT NULL DEFAULT 'down',
  ADD COLUMN "gateway_last_connected_at" TIMESTAMPTZ(6),
  ADD COLUMN "gateway_last_event_at"     TIMESTAMPTZ(6),
  ADD COLUMN "sync_state"                "SyncState"    NOT NULL DEFAULT 'idle',
  ADD COLUMN "last_sync_started_at"      TIMESTAMPTZ(6),
  ADD COLUMN "last_sync_at"              TIMESTAMPTZ(6),
  ADD COLUMN "last_sync_granted"         INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN "last_sync_revoked"         INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN "last_error"                TEXT;
