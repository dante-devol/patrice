-- ADR 0022: Member becomes a unit role; divisions and teams name a default role that
-- people get when they join; a hidden Everyone role (kind `baseline`) holds what every
-- signed-in person may do. The data move (seeding Everyone and Member, upgrading the
-- old org-wide Member) runs in the bootstrap, because a new enum value can't be used in
-- the transaction that adds it.

ALTER TYPE "RoleKind" ADD VALUE 'baseline';

ALTER TABLE "division" ADD COLUMN "default_role_id" UUID;
ALTER TABLE "team" ADD COLUMN "default_role_id" UUID;
ALTER TABLE "unit_role_assignment" ADD COLUMN "via_default" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "system_settings"
  ADD COLUMN "default_unit_role_id" UUID,
  ADD COLUMN "member_unit_seeded" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_default_unit_role_id_fkey"
  FOREIGN KEY ("default_unit_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "division" ADD CONSTRAINT "division_default_role_id_fkey"
  FOREIGN KEY ("default_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team" ADD CONSTRAINT "team_default_role_id_fkey"
  FOREIGN KEY ("default_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
