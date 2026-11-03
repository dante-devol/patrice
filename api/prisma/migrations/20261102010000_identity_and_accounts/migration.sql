-- Phase 1: identity & accounts.

-- 1. Server-side OAuth flows. `state` sent to the provider is an opaque random token
--    (stored hashed); the browser that started the flow holds a nonce cookie whose
--    hash must match at the callback. One row per flow, deleted when consumed.
CREATE TABLE "oauth_flow" (
    "id"                UUID NOT NULL DEFAULT uuidv7(),
    "state_hash"        TEXT NOT NULL,
    "nonce_hash"        TEXT NOT NULL,
    "provider"          "AuthProvider" NOT NULL,
    "intent"            TEXT NOT NULL,
    "user_id"           UUID,
    "invite_token_hash" TEXT,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"        TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "oauth_flow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "oauth_flow_intent" CHECK ("intent" IN ('login', 'register', 'link'))
);
CREATE UNIQUE INDEX "oauth_flow_state_hash_key" ON "oauth_flow"("state_hash");
CREATE INDEX "oauth_flow_expires_at_idx" ON "oauth_flow"("expires_at");
ALTER TABLE "oauth_flow" ADD CONSTRAINT "oauth_flow_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Email change: the new address waits on the token until it is verified.
ALTER TYPE "AuthTokenKind" ADD VALUE 'email_change';
ALTER TABLE "auth_token" ADD COLUMN "new_email" CITEXT;
