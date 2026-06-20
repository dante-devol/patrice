-- Slice 2.3 — grants gain their own lifecycle so the matrix can retire/revive a
-- grant row independently of its role (the projector now also filters on this).
ALTER TABLE "grant" ADD COLUMN "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active';
ALTER TABLE "grant" ADD COLUMN "retired_at" TIMESTAMPTZ(6);
ALTER TABLE "grant" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
