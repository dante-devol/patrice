-- Slice 4.1 — Task table.
-- A task deep-copies its division's default questionnaire into its own row; the copy
-- is reached via the inverse `questionnaire.owner_task_id` (there is no
-- `task.questionnaire_id` — removed in Slice 3). `status_cache` is the rolled-up
-- status (Slice 4 subset: open|claimed). This migration also lands the deferred FK
-- from `questionnaire.owner_task_id` → `task` (the column existed since Slice 3).

-- CreateEnum
CREATE TYPE "StatusCache" AS ENUM ('open', 'claimed', 'review', 'revising', 'approved');

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "division_id" UUID NOT NULL,
    "team_id" UUID,
    "requester_user_id" UUID NOT NULL,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "claims_closed" BOOLEAN NOT NULL DEFAULT false,
    "status_cache" "StatusCache",
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_division_id_idx" ON "task"("division_id");

-- CreateIndex
CREATE INDEX "task_team_id_idx" ON "task"("team_id");

-- CreateIndex
CREATE INDEX "task_status_cache_idx" ON "task"("status_cache");

-- CreateIndex
CREATE INDEX "task_requester_user_id_idx" ON "task"("requester_user_id");

-- CreateIndex
CREATE INDEX "task_organization_id_idx" ON "task"("organization_id");

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_division_id_fkey" FOREIGN KEY ("division_id") REFERENCES "division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: the deferred Slice 3 FK from a task-owned questionnaire to its task.
ALTER TABLE "questionnaire" ADD CONSTRAINT "questionnaire_owner_task_id_fkey" FOREIGN KEY ("owner_task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
