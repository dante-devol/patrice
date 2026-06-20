-- Slice 2.2 — Division + Team tables with inherent-role FK backstops.

-- CreateTable
CREATE TABLE "division" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "default_openings" INTEGER NOT NULL DEFAULT 1,
    "openings_locked" BOOLEAN NOT NULL DEFAULT false,
    "restrict_claims" BOOLEAN NOT NULL DEFAULT false,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "restrict_claims" BOOLEAN NOT NULL DEFAULT false,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "division_organization_id_idx" ON "division"("organization_id");

-- CreateIndex
CREATE INDEX "team_organization_id_idx" ON "team"("organization_id");

-- AddForeignKey
ALTER TABLE "division" ADD CONSTRAINT "division_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: inherent-role backstops (role.division_id / role.team_id already UNIQUE).
ALTER TABLE "role" ADD CONSTRAINT "role_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
