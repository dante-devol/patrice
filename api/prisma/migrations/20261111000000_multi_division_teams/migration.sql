-- Teams that serve more than one division (docs/plans/multi-division-teams.md). A team
-- supports either every division (all_divisions, including ones created later) or
-- exactly the divisions listed in team_division (at least one; the API enforces that).
-- Every existing team keeps its one division as its only row.

ALTER TABLE "team" ADD COLUMN "all_divisions" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "team_division" (
  "team_id"     UUID NOT NULL,
  "division_id" UUID NOT NULL,
  CONSTRAINT "team_division_pkey" PRIMARY KEY ("team_id", "division_id"),
  CONSTRAINT "team_division_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "team_division_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "team_division_division_id_idx" ON "team_division" ("division_id");

INSERT INTO "team_division" ("team_id", "division_id") SELECT "id", "division_id" FROM "team";

ALTER TABLE "team" DROP CONSTRAINT "team_division_id_fkey";
DROP INDEX "team_division_id_idx";
ALTER TABLE "team" DROP COLUMN "division_id";
