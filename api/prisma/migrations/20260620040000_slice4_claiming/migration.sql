-- Slice 4.2 — Task claimant slots.
-- A user occupies a slot from `joined_at` until `left_at` (NULL = active). The
-- UNIQUE(task_id, user_id) keeps one slot per user per task; re-claiming after a
-- leave reactivates the same row. Claim eligibility is enforced in Cedar, not here.

-- CreateTable
CREATE TABLE "task_claimant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "has_submitted" BOOLEAN NOT NULL DEFAULT false,
    "left_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_claimant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_claimant_task_id_user_id_key" ON "task_claimant"("task_id", "user_id");

-- CreateIndex
CREATE INDEX "task_claimant_task_id_idx" ON "task_claimant"("task_id");

-- CreateIndex
CREATE INDEX "task_claimant_user_id_idx" ON "task_claimant"("user_id");

-- AddForeignKey
ALTER TABLE "task_claimant" ADD CONSTRAINT "task_claimant_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_claimant" ADD CONSTRAINT "task_claimant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
