-- Rename the Questionnaire concept to Request Template, in place (no data loss).
-- `questionnaire` -> `request_template`; `question.questionnaire_id` -> `question.request_template_id`.
-- All constraints/indexes are renamed alongside so a future `prisma migrate dev`
-- diffs clean against the renamed model names.

-- RenameTable
ALTER TABLE "questionnaire" RENAME TO "request_template";

-- RenameConstraint (primary key)
ALTER TABLE "request_template" RENAME CONSTRAINT "questionnaire_pkey" TO "request_template_pkey";

-- RenameConstraint (foreign keys)
ALTER TABLE "request_template" RENAME CONSTRAINT "questionnaire_organization_id_fkey" TO "request_template_organization_id_fkey";
ALTER TABLE "request_template" RENAME CONSTRAINT "questionnaire_owner_division_id_fkey" TO "request_template_owner_division_id_fkey";
ALTER TABLE "request_template" RENAME CONSTRAINT "questionnaire_owner_task_id_fkey" TO "request_template_owner_task_id_fkey";

-- RenameConstraint (hand-applied exactly-one-owner CHECK)
ALTER TABLE "request_template" RENAME CONSTRAINT "questionnaire_exactly_one_owner" TO "request_template_exactly_one_owner";

-- RenameIndex
ALTER INDEX "questionnaire_owner_division_id_key" RENAME TO "request_template_owner_division_id_key";
ALTER INDEX "questionnaire_owner_task_id_key" RENAME TO "request_template_owner_task_id_key";
ALTER INDEX "questionnaire_organization_id_idx" RENAME TO "request_template_organization_id_idx";

-- RenameColumn
ALTER TABLE "question" RENAME COLUMN "questionnaire_id" TO "request_template_id";

-- RenameConstraint (question's FK + unique, following the column rename)
ALTER TABLE "question" RENAME CONSTRAINT "question_questionnaire_id_fkey" TO "question_request_template_id_fkey";

-- RenameIndex
ALTER INDEX "question_questionnaire_id_idx" RENAME TO "question_request_template_id_idx";
ALTER INDEX "question_questionnaire_id_ordinal_key" RENAME TO "question_request_template_id_ordinal_key";
