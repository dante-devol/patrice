-- Slice 8.2: external_identity table for Discord account linking

CREATE TABLE "external_identity" (
    "id"               UUID NOT NULL DEFAULT uuidv7(),
    "user_id"          UUID NOT NULL,
    "connection_id"    UUID NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "external_handle"  TEXT,
    "linked_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "last_synced_at"   TIMESTAMPTZ(6),

    CONSTRAINT "external_identity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "external_identity"
    ADD CONSTRAINT "external_identity_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_identity"
    ADD CONSTRAINT "external_identity_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "integration_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One Discord account per user per connection; one link per user per connection.
CREATE UNIQUE INDEX "external_identity_connection_id_external_user_id_key"
    ON "external_identity"("connection_id", "external_user_id");

CREATE UNIQUE INDEX "external_identity_user_id_connection_id_key"
    ON "external_identity"("user_id", "connection_id");

CREATE INDEX "external_identity_user_id_idx"
    ON "external_identity"("user_id");
