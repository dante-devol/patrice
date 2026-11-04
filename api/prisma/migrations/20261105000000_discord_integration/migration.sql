-- Phase 6: Discord integration.
--
-- 1. A mapping targets a role, a division membership or a team membership.
-- 2. A retired connection remembers what to do with the roles and memberships it
--    granted once it's collected (keep them as native, or revoke them).
-- 3. `IntegrationStatus.disabled` was never set by anything; it goes.

-- ---- 1. Mapping targets -----------------------------------------------------

ALTER TABLE "external_group_mapping" ALTER COLUMN "role_id" DROP NOT NULL;
ALTER TABLE "external_group_mapping"
  ADD COLUMN "division_id" UUID,
  ADD COLUMN "team_id" UUID;
ALTER TABLE "external_group_mapping" ADD CONSTRAINT "external_group_mapping_division_id_fkey"
  FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_group_mapping" ADD CONSTRAINT "external_group_mapping_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "external_group_mapping" ADD CONSTRAINT "external_group_mapping_one_target"
  CHECK (num_nonnulls("role_id", "division_id", "team_id") = 1);
-- Hand-applied: one mapping per (connection, group, target) for membership targets.
CREATE UNIQUE INDEX "external_group_mapping_division_target" ON "external_group_mapping"("connection_id", "external_group_id", "division_id") WHERE "division_id" IS NOT NULL;
CREATE UNIQUE INDEX "external_group_mapping_team_target" ON "external_group_mapping"("connection_id", "external_group_id", "team_id") WHERE "team_id" IS NOT NULL;

-- ---- 2. Retire disposition --------------------------------------------------

CREATE TYPE "GrantDisposition" AS ENUM ('keep', 'revoke');
ALTER TABLE "integration_connection" ADD COLUMN "retire_disposition" "GrantDisposition";

-- ---- 3. Status --------------------------------------------------------------

UPDATE "integration_connection" SET "status" = 'broken' WHERE "status" = 'disabled';
ALTER TYPE "IntegrationStatus" RENAME TO "IntegrationStatus_old";
CREATE TYPE "IntegrationStatus" AS ENUM ('active', 'broken');
ALTER TABLE "integration_connection" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "integration_connection"
  ALTER COLUMN "status" TYPE "IntegrationStatus" USING ("status"::text::"IntegrationStatus");
ALTER TABLE "integration_connection" ALTER COLUMN "status" SET DEFAULT 'active';
DROP TYPE "IntegrationStatus_old";

-- The role-target unique index, under the name Prisma expects.
ALTER INDEX "external_group_mapping_role_id_connection_id_external_group_id_" RENAME TO "external_group_mapping_role_id_connection_id_external_group_key";
