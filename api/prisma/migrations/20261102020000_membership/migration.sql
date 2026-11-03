-- Phase 2: membership separate from authority. Inherent division/team roles go away;
-- belonging to a unit becomes a `membership` row, and every team belongs to one division.

-- 1. Teams belong to exactly one division: the division most of the team's tasks use,
--    else the oldest division. A team with no division to join gets a new "General" one.
ALTER TABLE "team" ADD COLUMN "division_id" UUID;

UPDATE "team" t SET "division_id" = sub."division_id"
FROM (
  SELECT DISTINCT ON (k."team_id") k."team_id", k."division_id"
  FROM "task" k
  WHERE k."team_id" IS NOT NULL
  GROUP BY k."team_id", k."division_id"
  ORDER BY k."team_id", COUNT(*) DESC, k."division_id"
) sub
WHERE t."id" = sub."team_id";

UPDATE "team" SET "division_id" = (SELECT "id" FROM "division" ORDER BY "created_at" LIMIT 1)
WHERE "division_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "team" WHERE "division_id" IS NULL) THEN
    INSERT INTO "division" ("id", "name", "updated_at") VALUES (uuidv7(), 'General', now());
    UPDATE "team" SET "division_id" = (SELECT "id" FROM "division" ORDER BY "created_at" LIMIT 1)
    WHERE "division_id" IS NULL;
  END IF;
  -- Existing tasks whose team sits in another division are left as they are; the
  -- rule applies to new and edited tasks.
  IF EXISTS (
    SELECT 1 FROM "task" k JOIN "team" t ON t."id" = k."team_id" WHERE t."division_id" <> k."division_id"
  ) THEN
    RAISE NOTICE 'Some existing tasks use a team from another division; they keep it.';
  END IF;
END $$;

ALTER TABLE "team" ALTER COLUMN "division_id" SET NOT NULL;
ALTER TABLE "team" ADD CONSTRAINT "team_division_id_fkey"
  FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "team_division_id_idx" ON "team"("division_id");

-- 2. Membership: a user belongs to a division or a team. `source` records whether
--    Patrice or an integration (Discord sync) made the membership.
CREATE TABLE "membership" (
    "id"                   UUID NOT NULL DEFAULT uuidv7(),
    "user_id"              UUID NOT NULL,
    "division_id"          UUID,
    "team_id"              UUID,
    "source"               "UserRoleSource" NOT NULL DEFAULT 'patrice',
    "source_connection_id" UUID,
    "granted_by"           UUID,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "membership_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "membership_one_unit" CHECK (("division_id" IS NULL) <> ("team_id" IS NULL))
);
CREATE UNIQUE INDEX "membership_user_division_key" ON "membership"("user_id", "division_id") WHERE "division_id" IS NOT NULL;
CREATE UNIQUE INDEX "membership_user_team_key" ON "membership"("user_id", "team_id") WHERE "team_id" IS NOT NULL;
CREATE INDEX "membership_division_id_idx" ON "membership"("division_id");
CREATE INDEX "membership_team_id_idx" ON "membership"("team_id");
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership" ADD CONSTRAINT "membership_division_id_fkey"
  FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership" ADD CONSTRAINT "membership_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Holding an inherent role becomes a membership.
INSERT INTO "membership" ("user_id", "division_id", "team_id", "source", "source_connection_id", "granted_by", "created_at")
SELECT ur."user_id", r."division_id", r."team_id", ur."source", ur."source_connection_id", ur."granted_by", ur."granted_at"
FROM "user_role" ur JOIN "role" r ON r."id" = ur."role_id"
WHERE r."kind" IN ('division', 'team');

-- 4. An inherent role that carried authority or was referenced (grants, role-scoped
--    grants, a Discord mapping, a pending invitation) is replaced by an ordinary role
--    of the same name, held by the same people, so nobody gains or loses access. Its
--    grants, mappings and references move to the new role.
CREATE TEMP TABLE "inherent_replacement" ON COMMIT DROP AS
SELECT r."id" AS "old_id", uuidv7() AS "new_id", r."name", r."lifecycle_state", r."retired_at"
FROM "role" r
WHERE r."kind" IN ('division', 'team')
  AND (EXISTS (SELECT 1 FROM "grant" g WHERE g."role_id" = r."id" OR g."scope_role_id" = r."id")
    OR EXISTS (SELECT 1 FROM "external_group_mapping" m WHERE m."role_id" = r."id")
    OR EXISTS (SELECT 1 FROM "invitation" i WHERE r."id" = ANY(i."intended_role_ids")));

INSERT INTO "role" ("id", "name", "kind", "lifecycle_state", "retired_at", "updated_at")
SELECT "new_id", "name", 'standalone', "lifecycle_state", "retired_at", now() FROM "inherent_replacement";

INSERT INTO "user_role" ("user_id", "role_id", "source", "source_connection_id", "granted_by", "granted_at", "updated_at")
SELECT ur."user_id", x."new_id", ur."source", ur."source_connection_id", ur."granted_by", ur."granted_at", now()
FROM "user_role" ur JOIN "inherent_replacement" x ON x."old_id" = ur."role_id";

UPDATE "grant" g SET "role_id" = x."new_id" FROM "inherent_replacement" x WHERE g."role_id" = x."old_id";
UPDATE "grant" g SET "scope_role_id" = x."new_id" FROM "inherent_replacement" x WHERE g."scope_role_id" = x."old_id";
UPDATE "external_group_mapping" m SET "role_id" = x."new_id" FROM "inherent_replacement" x WHERE m."role_id" = x."old_id";
UPDATE "invitation" i SET "intended_role_ids" = ARRAY(
  SELECT COALESCE(x."new_id", rid)
  FROM unnest(i."intended_role_ids") AS rid
  LEFT JOIN "inherent_replacement" x ON x."old_id" = rid
);

-- 5. Remove the inherent roles themselves (nothing references them any more).
DELETE FROM "user_role" WHERE "role_id" IN (SELECT "id" FROM "role" WHERE "kind" IN ('division', 'team'));
DELETE FROM "role" WHERE "kind" IN ('division', 'team');

ALTER TABLE "role" DROP COLUMN "division_id";
ALTER TABLE "role" DROP COLUMN "team_id";
ALTER TABLE "role" DROP COLUMN "kind";
DROP TYPE "RoleKind";

-- 6. The seeded Member role (editable; new invitations pre-assign it). Remembered by
--    id so renaming it doesn't re-seed a second one; seeded at most once.
ALTER TABLE "system_settings" ADD COLUMN "member_role_id" UUID;
ALTER TABLE "system_settings" ADD COLUMN "member_role_seeded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_member_role_id_fkey"
  FOREIGN KEY ("member_role_id") REFERENCES "role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
