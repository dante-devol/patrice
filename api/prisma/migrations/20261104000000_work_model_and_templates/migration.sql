-- Phase 4: work model & templates.
--
-- 1. Request templates split in two: a division's library (`request_template` +
--    `request_template_question`) and each task's own snapshot (`task_question`).
--    Answers point at task questions, which keep their ids, so nothing breaks.
-- 2. Completion is a fact (`task.completed_at`, `completed_by`), and `status_cache`
--    is always set.
-- 3. Uploads may be pending (owned by their uploader, attached to nothing yet), and
--    every attachment records its task.
-- 4. Openings are at least 1.

-- ---- 1. Templates ------------------------------------------------------------

CREATE TYPE "TemplateOrigin" AS ENUM ('library', 'custom');

CREATE TABLE "task_question" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "task_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "source_question_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "task_question_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_question_task_id_ordinal_key" ON "task_question"("task_id", "ordinal");
ALTER TABLE "task_question" ADD CONSTRAINT "task_question_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task"
  ADD COLUMN "source_template_id" UUID,
  ADD COLUMN "template_origin" "TemplateOrigin" NOT NULL DEFAULT 'library';

-- Each task-owned copy becomes task questions with the same ids.
INSERT INTO "task_question" ("id", "task_id", "ordinal", "type", "prompt", "required", "constraints", "created_at", "updated_at")
SELECT q."id", rt."owner_task_id", q."ordinal", q."type", q."prompt", q."required", q."constraints", q."created_at", q."updated_at"
FROM "question" q
JOIN "request_template" rt ON rt."id" = q."request_template_id"
WHERE rt."owner_task_id" IS NOT NULL;

ALTER TABLE "answer" DROP CONSTRAINT "answer_question_id_fkey";
ALTER TABLE "answer" ADD CONSTRAINT "answer_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "task_question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Provenance: every existing task came from its division's (single) template.
UPDATE "task" t SET "source_template_id" = rt."id"
FROM "request_template" rt
WHERE rt."owner_division_id" = t."division_id";

DELETE FROM "question" q USING "request_template" rt
WHERE rt."id" = q."request_template_id" AND rt."owner_task_id" IS NOT NULL;
DELETE FROM "request_template" WHERE "owner_task_id" IS NOT NULL;

-- What's left is the division library: each division's template is its "Default".
ALTER TABLE "request_template" DROP CONSTRAINT "request_template_exactly_one_owner";
ALTER TABLE "request_template" DROP CONSTRAINT "request_template_owner_task_id_fkey";
DROP INDEX "request_template_owner_task_id_key";
ALTER TABLE "request_template" DROP COLUMN "owner_task_id";
DROP INDEX "request_template_owner_division_id_key";
ALTER TABLE "request_template" RENAME COLUMN "owner_division_id" TO "division_id";
ALTER TABLE "request_template" ALTER COLUMN "division_id" SET NOT NULL;
ALTER TABLE "request_template" RENAME CONSTRAINT "request_template_owner_division_id_fkey" TO "request_template_division_id_fkey";
ALTER TABLE "request_template"
  ADD COLUMN "name" CITEXT NOT NULL DEFAULT 'Default',
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
UPDATE "request_template" SET "is_default" = true;
ALTER TABLE "request_template" ALTER COLUMN "name" DROP DEFAULT;
CREATE UNIQUE INDEX "request_template_division_id_name_key" ON "request_template"("division_id", "name");
-- At most one default per division (hand-applied: Prisma can't express a partial index).
CREATE UNIQUE INDEX "request_template_one_default" ON "request_template"("division_id") WHERE "is_default";

ALTER TABLE "question" RENAME TO "request_template_question";
ALTER TABLE "request_template_question" RENAME CONSTRAINT "question_pkey" TO "request_template_question_pkey";
ALTER TABLE "request_template_question" RENAME CONSTRAINT "question_request_template_id_fkey" TO "request_template_question_request_template_id_fkey";
ALTER INDEX "question_request_template_id_idx" RENAME TO "request_template_question_request_template_id_idx";
ALTER INDEX "question_request_template_id_ordinal_key" RENAME TO "request_template_question_request_template_id_ordinal_key";

ALTER TABLE "task" ADD CONSTRAINT "task_source_template_id_fkey"
  FOREIGN KEY ("source_template_id") REFERENCES "request_template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "division" ADD COLUMN "allow_custom_templates" BOOLEAN NOT NULL DEFAULT false;

-- ---- 2. Completion and status -----------------------------------------------

ALTER TABLE "task"
  ADD COLUMN "completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "completed_by" UUID;
ALTER TABLE "task" ADD CONSTRAINT "task_completed_by_fkey"
  FOREIGN KEY ("completed_by") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A manual completion left only a cache value and its timeline event; turn the
-- ones still standing into facts. Completion closes claims.
UPDATE "task" t SET "completed_at" = e."occurred_at", "completed_by" = e."actor_user_id", "claims_closed" = true
FROM (
  SELECT DISTINCT ON ("task_id") "task_id", "occurred_at", "actor_user_id"
  FROM "domain_event" WHERE "type" = 'task.completed'
  ORDER BY "task_id", "occurred_at" DESC
) e
WHERE e."task_id" = t."id" AND t."status_cache" = 'approved';

-- Openings are at least 1 (fixed before statuses are derived from them).
UPDATE "division" SET "default_openings" = 1 WHERE "default_openings" < 1;
ALTER TABLE "division" ADD CONSTRAINT "division_default_openings_positive" CHECK ("default_openings" >= 1);
UPDATE "task" SET "openings" = 1 WHERE "openings" < 1;
ALTER TABLE "task" ADD CONSTRAINT "task_openings_positive" CHECK ("openings" >= 1);

UPDATE "task" t SET "status_cache" = CASE
    WHEN t."claims_closed" OR (SELECT count(*) FROM "task_claimant" c WHERE c."task_id" = t."id" AND c."left_at" IS NULL) >= t."openings"
    THEN 'claimed'::"StatusCache" ELSE 'open'::"StatusCache" END
WHERE t."status_cache" IS NULL;
ALTER TABLE "task" ALTER COLUMN "status_cache" SET NOT NULL;

-- Completing a task marks outstanding submissions as no longer required.
ALTER TYPE "SubmissionState" ADD VALUE 'not_required';

-- ---- 3. Attachments ---------------------------------------------------------

ALTER TABLE "attachment" ADD COLUMN "task_id" UUID;
UPDATE "attachment" a SET "task_id" = m."task_id" FROM "message" m WHERE m."id" = a."message_id";
UPDATE "attachment" a SET "task_id" = s."task_id"
FROM "answer" an JOIN "submission" s ON s."id" = an."submission_id"
WHERE an."id" = a."answer_id";
ALTER TABLE "attachment" ALTER COLUMN "task_id" SET NOT NULL;
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "attachment_task_id_idx" ON "attachment"("task_id");

-- An attachment belongs to a message or an answer, never both; neither means it's
-- a pending upload, owned by its uploader until a submit or message claims it.
ALTER TABLE "attachment" DROP CONSTRAINT "attachment_exactly_one_owner";
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_at_most_one_owner"
  CHECK ("message_id" IS NULL OR "answer_id" IS NULL);
