-- ADR 0021: `own` on reading and commenting now means "requested it or holds a seat",
-- no longer "or could claim it", and claiming has no `own` scope (claim restrictions
-- are a static forbid instead). So a role keeps reaching the tasks of the units its
-- holders belong to, every `own` permit on those actions gains `own_division` and
-- `own_team` siblings, and `task:assign` @ own becomes those two.

INSERT INTO "grant" ("role_id", "action", "effect", "scope_kind", "updated_at")
SELECT DISTINCT g."role_id", g."action", g."effect", s.kind, CURRENT_TIMESTAMP
FROM "grant" g
CROSS JOIN (VALUES ('own_division'::"ScopeKind"), ('own_team'::"ScopeKind")) AS s(kind)
WHERE g."scope_kind" = 'own'
  AND g."effect" = 'permit'
  AND g."action" IN ('task:read', 'message:read', 'submission:read', 'attachment:read', 'message:create', 'task:assign')
  AND NOT EXISTS (
    SELECT 1 FROM "grant" x
    WHERE x."role_id" = g."role_id" AND x."action" = g."action"
      AND x."effect" = g."effect" AND x."scope_kind" = s.kind
  );

DELETE FROM "grant" WHERE "action" = 'task:assign' AND "scope_kind" = 'own';

UPDATE "system_settings" SET "config_version" = "config_version" + 1;
