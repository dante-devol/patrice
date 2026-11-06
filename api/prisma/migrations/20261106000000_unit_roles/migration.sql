-- Unit roles: roles assigned at a division or team, whose grants apply only there.
-- See docs/plans/projects-and-unit-roles.md and ADR 0019.

CREATE TYPE "RoleKind" AS ENUM ('org', 'unit');
ALTER TABLE "role"
  ADD COLUMN "kind" "RoleKind" NOT NULL DEFAULT 'org',
  ADD COLUMN "assignable_by_leads" BOOLEAN NOT NULL DEFAULT false;
-- Only a unit role can be assignable by leads.
ALTER TABLE "role" ADD CONSTRAINT "role_assignable_by_leads_unit_only"
  CHECK ("kind" = 'unit' OR NOT "assignable_by_leads");

ALTER TYPE "ScopeKind" ADD VALUE 'assigned';

CREATE TABLE "unit_role_assignment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "division_id" UUID,
    "team_id" UUID,
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_role_assignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "unit_role_assignment_one_unit" CHECK (("division_id" IS NULL) <> ("team_id" IS NULL))
);
CREATE INDEX "unit_role_assignment_user_id_idx" ON "unit_role_assignment"("user_id");
CREATE INDEX "unit_role_assignment_role_id_idx" ON "unit_role_assignment"("role_id");
CREATE INDEX "unit_role_assignment_division_id_idx" ON "unit_role_assignment"("division_id");
CREATE INDEX "unit_role_assignment_team_id_idx" ON "unit_role_assignment"("team_id");
-- Hand-applied: one assignment per (user, role, unit).
CREATE UNIQUE INDEX "unit_role_assignment_division_key" ON "unit_role_assignment"("user_id", "role_id", "division_id") WHERE "division_id" IS NOT NULL;
CREATE UNIQUE INDEX "unit_role_assignment_team_key" ON "unit_role_assignment"("user_id", "role_id", "team_id") WHERE "team_id" IS NOT NULL;

ALTER TABLE "unit_role_assignment" ADD CONSTRAINT "unit_role_assignment_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_role_assignment" ADD CONSTRAINT "unit_role_assignment_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_role_assignment" ADD CONSTRAINT "unit_role_assignment_division_id_fkey"
  FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_role_assignment" ADD CONSTRAINT "unit_role_assignment_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The seeded "Project lead" unit role is created once, at boot.
ALTER TABLE "system_settings" ADD COLUMN "project_lead_seeded" BOOLEAN NOT NULL DEFAULT false;
