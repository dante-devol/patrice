-- Slice E (#59): sync_baseline table + conflict_winner on external_group_mapping

-- conflict_winner enum
CREATE TYPE "ConflictWinner" AS ENUM ('patrice', 'external');

-- Add conflict_winner to external_group_mapping (default patrice)
ALTER TABLE "external_group_mapping"
  ADD COLUMN "conflict_winner" "ConflictWinner" NOT NULL DEFAULT 'patrice';

-- sync_baseline table
CREATE TABLE "sync_baseline" (
  "id"               UUID      NOT NULL DEFAULT uuidv7(),
  "connection_id"    UUID      NOT NULL,
  "mapping_id"       UUID      NOT NULL,
  "external_user_id" TEXT      NOT NULL,
  "external_group_id" TEXT     NOT NULL,
  "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "sync_baseline_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sync_baseline_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "integration_connection"("id") ON DELETE CASCADE,
  CONSTRAINT "sync_baseline_mapping_id_fkey"
    FOREIGN KEY ("mapping_id") REFERENCES "external_group_mapping"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "sync_baseline_connection_mapping_user_group_key"
  ON "sync_baseline"("connection_id", "mapping_id", "external_user_id", "external_group_id");

CREATE INDEX "sync_baseline_connection_id_idx" ON "sync_baseline"("connection_id");
CREATE INDEX "sync_baseline_mapping_id_idx"    ON "sync_baseline"("mapping_id");
