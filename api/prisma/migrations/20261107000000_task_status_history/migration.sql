-- Task status history: one row each time a task's displayed state changes, written by
-- a trigger so every write path (claims, submissions, reviews, completion, retire,
-- revive) records it. Feeds the status-over-time chart on division and team pages.
-- The state is the task's status, except a completed task is 'done' and a retired
-- one is 'retired'.

CREATE TYPE "TaskState" AS ENUM ('open', 'claimed', 'review', 'revising', 'approved', 'done', 'retired');

CREATE TABLE "task_status_history" (
  "id"         UUID        NOT NULL DEFAULT uuidv7(),
  "task_id"    UUID        NOT NULL,
  "state"      "TaskState" NOT NULL,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "task_status_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_status_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_status_history_task_id_changed_at_idx" ON "task_status_history" ("task_id", "changed_at");

CREATE FUNCTION task_state_of(lifecycle "LifecycleState", completed TIMESTAMPTZ, status "StatusCache")
RETURNS "TaskState" LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lifecycle = 'retired' THEN 'retired'::"TaskState"
    WHEN completed IS NOT NULL THEN 'done'::"TaskState"
    ELSE status::text::"TaskState"
  END
$$;

CREATE FUNCTION task_status_history_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_state "TaskState" := task_state_of(NEW.lifecycle_state, NEW.completed_at, NEW.status_cache);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_status_history (task_id, state, changed_at) VALUES (NEW.id, next_state, NEW.created_at);
  ELSIF next_state IS DISTINCT FROM task_state_of(OLD.lifecycle_state, OLD.completed_at, OLD.status_cache) THEN
    INSERT INTO task_status_history (task_id, state) VALUES (NEW.id, next_state);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER task_status_history_insert AFTER INSERT ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_status_history_record();
CREATE TRIGGER task_status_history_update AFTER UPDATE OF status_cache, lifecycle_state, completed_at ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_status_history_record();

-- Backfill: existing tasks were open when created; if they've moved on, record the
-- current state at the best time we have (completion, retirement, else last update).
INSERT INTO task_status_history (task_id, state, changed_at)
  SELECT id, 'open', created_at FROM "task";
INSERT INTO task_status_history (task_id, state, changed_at)
  SELECT id,
         task_state_of(lifecycle_state, completed_at, status_cache),
         GREATEST(created_at, COALESCE(CASE WHEN lifecycle_state = 'retired' THEN retired_at END, completed_at, updated_at))
  FROM "task"
  WHERE task_state_of(lifecycle_state, completed_at, status_cache) <> 'open';
