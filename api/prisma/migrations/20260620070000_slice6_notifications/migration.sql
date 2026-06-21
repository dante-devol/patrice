-- Slice 6 — Notifications.
-- One `notification` row per recipient, inserted when a domain event fires. The
-- recipient cohort is snapshotted into `payload` at event time and never re-resolved
-- at delivery. `event_seq` is monotonic per (subject_type, subject_id, type); the
-- UNIQUE(recipient_user_id, type, subject_id, event_seq) index makes insertion
-- idempotent — a retry carrying the same tuple collides and no-ops. `type` is free
-- text constrained by the app's fixed enumeration (no DB enum so the v1 set can grow
-- without a migration). `payload` is IDs-only per Activity Payload Discipline.

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "event_seq" BIGINT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotency guard)
CREATE UNIQUE INDEX "notification_recipient_user_id_type_subject_id_event_seq_key" ON "notification"("recipient_user_id", "type", "subject_id", "event_seq");

-- CreateIndex (unread-badge + feed keyset)
CREATE INDEX "notification_recipient_user_id_read_at_created_at_idx" ON "notification"("recipient_user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notification_organization_id_idx" ON "notification"("organization_id");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
