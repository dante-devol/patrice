-- Slice 4.3 — Messages + Attachments.
-- Messages are ONE level deep: a reply's parent must itself be top-level. A row CHECK
-- can't see another row, so one-level threading is enforced by a trigger (+ an app
-- guard). Attachments reference EXACTLY ONE of a message or an answer (answer_id's FK
-- arrives in Slice 5) — that one is a plain row CHECK.

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('comment', 'system');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('image', 'text', 'audio', 'model', 'other');

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "task_id" UUID NOT NULL,
    "kind" "MessageKind" NOT NULL DEFAULT 'comment',
    "sender_user_id" UUID,
    "parent_message_id" UUID,
    "submission_id" UUID,
    "body" TEXT NOT NULL,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "edited_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "message_id" UUID,
    "answer_id" UUID,
    "uploader_user_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "kind" "AttachmentKind" NOT NULL DEFAULT 'other',
    "checksum" TEXT,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_task_id_created_at_idx" ON "message"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "message_parent_message_id_idx" ON "message"("parent_message_id");

-- CreateIndex
CREATE INDEX "attachment_message_id_idx" ON "attachment"("message_id");

-- CreateIndex
CREATE INDEX "attachment_answer_id_idx" ON "attachment"("answer_id");

-- CreateIndex
CREATE INDEX "attachment_organization_id_idx" ON "attachment"("organization_id");

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploader_user_id_fkey" FOREIGN KEY ("uploader_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-applied: attachment references EXACTLY ONE owner (message XOR answer).
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_exactly_one_owner"
  CHECK (("message_id" IS NOT NULL)::int + ("answer_id" IS NOT NULL)::int = 1);

-- Hand-applied: one-level threading. A reply's parent must itself be top-level
-- (parent_message_id IS NULL). A row CHECK can't reach the parent row, so a trigger
-- enforces it; the app guard returns the friendly 422 before this ever fires.
CREATE OR REPLACE FUNCTION enforce_one_level_thread() RETURNS trigger AS $$
DECLARE
  parent_parent UUID;
BEGIN
  IF NEW.parent_message_id IS NOT NULL THEN
    SELECT parent_message_id INTO parent_parent FROM message WHERE id = NEW.parent_message_id;
    IF parent_parent IS NOT NULL THEN
      RAISE EXCEPTION 'reply-to-reply not allowed: messages are one level deep'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_one_level_thread
  BEFORE INSERT OR UPDATE ON "message"
  FOR EACH ROW EXECUTE FUNCTION enforce_one_level_thread();
