-- Slice 8.1: integration_connection table + enums

CREATE TYPE "IntegrationProvider" AS ENUM ('discord');
CREATE TYPE "IntegrationStatus" AS ENUM ('active', 'broken', 'disabled');

CREATE TABLE "integration_connection" (
    "id"                    UUID NOT NULL DEFAULT uuidv7(),
    "organization_id"       UUID NOT NULL,
    "provider"              "IntegrationProvider" NOT NULL,
    "external_workspace_id" TEXT NOT NULL,
    "display_name"          TEXT NOT NULL,
    "config"                JSONB NOT NULL DEFAULT '{}',
    "credentials_ref"       TEXT,
    "status"                "IntegrationStatus" NOT NULL DEFAULT 'active',
    "lifecycle_state"       "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at"            TIMESTAMPTZ(6),
    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "integration_connection"
    ADD CONSTRAINT "integration_connection_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "integration_connection_organization_id_provider_external_workspace_id_key"
    ON "integration_connection"("organization_id", "provider", "external_workspace_id");

CREATE INDEX "integration_connection_organization_id_idx"
    ON "integration_connection"("organization_id");
