-- Slice 8.3: external_group_mapping + SyncDirection enum

CREATE TYPE "SyncDirection" AS ENUM ('inbound', 'outbound', 'bidirectional');

CREATE TABLE "external_group_mapping" (
    "id"                UUID NOT NULL DEFAULT uuidv7(),
    "role_id"           UUID NOT NULL,
    "connection_id"     UUID NOT NULL,
    "external_group_id" TEXT NOT NULL,
    "sync_direction"    "SyncDirection" NOT NULL,
    "is_broken"         BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_group_mapping_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "external_group_mapping"
    ADD CONSTRAINT "external_group_mapping_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_group_mapping"
    ADD CONSTRAINT "external_group_mapping_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "integration_connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "external_group_mapping_role_id_connection_id_external_group_id_key"
    ON "external_group_mapping"("role_id", "connection_id", "external_group_id");

CREATE INDEX "external_group_mapping_connection_id_idx"
    ON "external_group_mapping"("connection_id");
