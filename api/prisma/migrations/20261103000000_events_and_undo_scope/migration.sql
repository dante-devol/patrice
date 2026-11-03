-- Phase 3: one typed event stream (timeline + notifications), undo only where it's
-- needed, notifications keyed on events, and foreign keys for loose references.

-- 1. Domain events. Timeline entries are the events with a task; `recipients` is the
--    notification fan-out snapshotted when the event happened; `notified_at` marks the
--    notification projection as done (null = still to deliver).
CREATE TABLE "domain_event" (
    "id"            UUID NOT NULL DEFAULT uuidv7(),
    "type"          TEXT NOT NULL,
    "task_id"       UUID,
    "actor_user_id" UUID,
    "payload"       JSONB NOT NULL DEFAULT '{}',
    "notify_type"   TEXT,
    "recipients"    UUID[] NOT NULL DEFAULT '{}',
    "notified_at"   TIMESTAMPTZ(6),
    "occurred_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "domain_event_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "domain_event_task_id_occurred_at_idx" ON "domain_event"("task_id", "occurred_at");
CREATE INDEX "domain_event_undelivered_idx" ON "domain_event"("occurred_at") WHERE "notified_at" IS NULL;
ALTER TABLE "domain_event" ADD CONSTRAINT "domain_event_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Turn the old system messages (sentences the client parsed) into typed events.
--    They were notified when they happened, so they're marked delivered.
INSERT INTO "domain_event" ("type", "task_id", "actor_user_id", "payload", "notified_at", "occurred_at")
SELECT x.type, m."task_id", x.actor, x.payload, m."created_at", m."created_at"
FROM "message" m
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN m."body" ~ '^User \S+ claimed this task\.?$' THEN 'task.claimed'
      WHEN m."body" ~ '^User \S+ left this task\.?$' THEN 'task.left'
      WHEN m."body" ~ '^User \S+ marked this task complete\.?$' THEN 'task.completed'
      WHEN m."body" ~ '^Requester changed to user \S+?\.?$' THEN 'task.requester_changed'
      WHEN m."body" ~ '^User \S+ submitted version \d+\.?$' THEN 'submission.submitted'
      WHEN m."body" ~ '^Reviewer \S+ (approved|returned|rejected) version \d+\.?$' THEN 'submission.reviewed'
      WHEN m."body" LIKE '{%submission_retired%' THEN 'submission.retired'
    END AS type,
    CASE
      WHEN m."body" ~ '^(User|Reviewer) [0-9a-f-]{36} '
        THEN (regexp_match(m."body", '^(?:User|Reviewer) ([0-9a-f-]{36}) '))[1]::uuid
      WHEN m."body" LIKE '{%' THEN (m."body"::jsonb->>'retiredBy')::uuid
    END AS actor,
    CASE
      WHEN m."body" ~ '^User \S+ (claimed|left) this task\.?$'
        THEN jsonb_build_object('userId', (regexp_match(m."body", '^User (\S+) '))[1])
      WHEN m."body" ~ '^Requester changed to user \S+?\.?$'
        THEN jsonb_build_object('toUserId', (regexp_match(m."body", '^Requester changed to user (\S+?)\.?$'))[1])
      WHEN m."body" ~ '^User \S+ submitted version \d+\.?$'
        THEN jsonb_build_object('submissionId', m."submission_id",
               'submissionNo', ((regexp_match(m."body", 'version (\d+)'))[1])::int)
      WHEN m."body" ~ '^Reviewer \S+ (approved|returned|rejected) version \d+\.?$'
        THEN jsonb_build_object('submissionId', m."submission_id",
               'submissionNo', ((regexp_match(m."body", 'version (\d+)'))[1])::int,
               'decision', CASE (regexp_match(m."body", ' (approved|returned|rejected) '))[1]
                             WHEN 'approved' THEN 'approve' WHEN 'returned' THEN 'return' ELSE 'reject' END)
      WHEN m."body" LIKE '{%'
        THEN jsonb_build_object('submissionNo', (m."body"::jsonb->>'submissionNo')::int,
               'claimantUserId', m."body"::jsonb->>'claimantUserId',
               'reason', m."body"::jsonb->>'reason')
      ELSE '{}'::jsonb
    END AS payload
) x
WHERE m."kind" = 'system' AND x.type IS NOT NULL;

-- Comments replying to a system message become top-level comments on the submission
-- that message hosted; then the system messages go.
UPDATE "message" c SET "parent_message_id" = NULL, "submission_id" = COALESCE(c."submission_id", p."submission_id")
FROM "message" p WHERE c."parent_message_id" = p."id" AND p."kind" = 'system';
DELETE FROM "message" WHERE "kind" = 'system';
ALTER TABLE "message" DROP COLUMN "kind";
DROP TYPE "MessageKind";

-- 3. Undo scope: grants, messages and attachments are hard-deleted (with an audit row)
--    rather than retired. Already-retired rows go now; a retired message with replies
--    stays as a "deleted" marker so its thread keeps its shape.
ALTER TABLE "message" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
UPDATE "message" m SET "deleted_at" = m."retired_at", "body" = ''
WHERE m."lifecycle_state" = 'retired'
  AND EXISTS (SELECT 1 FROM "message" r WHERE r."parent_message_id" = m."id");
DELETE FROM "attachment" a USING "message" m
WHERE a."message_id" = m."id" AND m."lifecycle_state" = 'retired';
DELETE FROM "message" WHERE "lifecycle_state" = 'retired' AND "deleted_at" IS NULL;
DELETE FROM "attachment" WHERE "lifecycle_state" = 'retired';
DELETE FROM "grant" WHERE "lifecycle_state" = 'retired';
ALTER TABLE "message" DROP COLUMN "lifecycle_state", DROP COLUMN "retired_at";
ALTER TABLE "attachment" DROP COLUMN "lifecycle_state", DROP COLUMN "retired_at";
ALTER TABLE "grant" DROP COLUMN "lifecycle_state", DROP COLUMN "retired_at";

-- 4. Notifications are a projection of events: one per (event, recipient), which makes
--    redelivery a no-op. The old per-subject sequence goes.
ALTER TABLE "notification" ADD COLUMN "event_id" UUID;
ALTER TABLE "notification" DROP COLUMN "event_seq";
CREATE UNIQUE INDEX "notification_event_id_recipient_user_id_key"
  ON "notification"("event_id", "recipient_user_id");
ALTER TABLE "notification" ADD CONSTRAINT "notification_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "domain_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Real foreign keys for references that were bare ids. A grant scoped to a unit or
--    role that's gone means nothing, so it goes with it.
DELETE FROM "grant" g WHERE g."scope_division_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "division" d WHERE d."id" = g."scope_division_id");
DELETE FROM "grant" g WHERE g."scope_team_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "team" t WHERE t."id" = g."scope_team_id");
DELETE FROM "grant" g WHERE g."scope_role_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "role" r WHERE r."id" = g."scope_role_id");
ALTER TABLE "grant" ADD CONSTRAINT "grant_scope_division_id_fkey"
  FOREIGN KEY ("scope_division_id") REFERENCES "division"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grant" ADD CONSTRAINT "grant_scope_team_id_fkey"
  FOREIGN KEY ("scope_team_id") REFERENCES "team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grant" ADD CONSTRAINT "grant_scope_role_id_fkey"
  FOREIGN KEY ("scope_role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "invitation_role" (
    "invitation_id" UUID NOT NULL,
    "role_id"       UUID NOT NULL,
    CONSTRAINT "invitation_role_pkey" PRIMARY KEY ("invitation_id", "role_id")
);
ALTER TABLE "invitation_role" ADD CONSTRAINT "invitation_role_invitation_id_fkey"
  FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitation_role" ADD CONSTRAINT "invitation_role_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "invitation_role" ("invitation_id", "role_id")
SELECT DISTINCT i."id", rid FROM "invitation" i, unnest(i."intended_role_ids") AS rid
WHERE EXISTS (SELECT 1 FROM "role" r WHERE r."id" = rid);
ALTER TABLE "invitation" DROP COLUMN "intended_role_ids";

-- 6. The retire/revive actions of hard-deleted things become one delete action each.
UPDATE "grant" SET "action" = 'message:delete' WHERE "action" = 'message:retire';
UPDATE "grant" SET "action" = 'attachment:delete' WHERE "action" = 'attachment:retire';
UPDATE "grant" SET "action" = 'grant:delete' WHERE "action" = 'grant:retire';
DELETE FROM "grant" WHERE "action" IN ('message:revive', 'attachment:revive', 'grant:revive');
