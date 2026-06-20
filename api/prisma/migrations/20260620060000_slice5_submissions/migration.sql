-- Slice 5 — Submissions & review lifecycle.
-- `submission` carries answers + a per-version review state; `submission_no` is the
-- resubmission counter (part of identity, UNIQUE per task+claimant) while `version`
-- is the optimistic-lock counter for version-guarded review UPDATEs. The
-- `message.submission_id` and `attachment.answer_id` columns landed as bare columns
-- in Slice 4; their FKs are added here now that their targets exist.

-- CreateEnum
CREATE TYPE "SubmissionState" AS ENUM ('review', 'revising', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "submission" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "task_id" UUID NOT NULL,
    "claimant_user_id" UUID NOT NULL,
    "submission_no" INTEGER NOT NULL,
    "prev_submission_id" UUID,
    "state" "SubmissionState" NOT NULL DEFAULT 'review',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "submission_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "value" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "submission_task_id_claimant_user_id_submission_no_key" ON "submission"("task_id", "claimant_user_id", "submission_no");

-- CreateIndex
CREATE INDEX "submission_task_id_idx" ON "submission"("task_id");

-- CreateIndex
CREATE INDEX "submission_claimant_user_id_idx" ON "submission"("claimant_user_id");

-- CreateIndex
CREATE INDEX "answer_submission_id_idx" ON "answer"("submission_id");

-- CreateIndex
CREATE INDEX "message_submission_id_idx" ON "message"("submission_id");

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_claimant_user_id_fkey" FOREIGN KEY ("claimant_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_prev_submission_id_fkey" FOREIGN KEY ("prev_submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer" ADD CONSTRAINT "answer_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer" ADD CONSTRAINT "answer_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey (Slice 4 bare columns gain their FKs now that the targets exist)
ALTER TABLE "message" ADD CONSTRAINT "message_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "answer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
