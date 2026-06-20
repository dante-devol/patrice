-- Slice 3.1 — Questionnaire + Question tables.
-- A questionnaire is owned by EXACTLY ONE of a division (default) or a task (copy,
-- Slice 4). The two owner columns are each UNIQUE and a CHECK enforces exactly one
-- is set — ownership exclusivity is the schema's backstop, not just the test suite.

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('detail_text', 'multiline', 'text', 'numeric', 'dropdown', 'radio', 'attachment');

-- CreateTable
CREATE TABLE "questionnaire" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "owner_division_id" UUID,
    "owner_task_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "questionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "questionnaire_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "constraints" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_owner_division_id_key" ON "questionnaire"("owner_division_id");

-- CreateIndex
CREATE UNIQUE INDEX "questionnaire_owner_task_id_key" ON "questionnaire"("owner_task_id");

-- CreateIndex
CREATE INDEX "questionnaire_organization_id_idx" ON "questionnaire"("organization_id");

-- CreateIndex
CREATE INDEX "question_questionnaire_id_idx" ON "question"("questionnaire_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_questionnaire_id_ordinal_key" ON "question"("questionnaire_id", "ordinal");

-- AddForeignKey
ALTER TABLE "questionnaire" ADD CONSTRAINT "questionnaire_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questionnaire" ADD CONSTRAINT "questionnaire_owner_division_id_fkey" FOREIGN KEY ("owner_division_id") REFERENCES "division"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question" ADD CONSTRAINT "question_questionnaire_id_fkey" FOREIGN KEY ("questionnaire_id") REFERENCES "questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-applied: exactly-one-owner CHECK. Prisma can't express it; this is the
-- backstop behind the architecture's "editing a division default never mutates
-- existing tasks" claim — no row is ever both a division-default and a task-copy.
-- (`owner_task_id`'s FK to `task` is added in Slice 4 alongside the task table.)
ALTER TABLE "questionnaire" ADD CONSTRAINT "questionnaire_exactly_one_owner"
  CHECK (("owner_division_id" IS NOT NULL)::int + ("owner_task_id" IS NOT NULL)::int = 1);
