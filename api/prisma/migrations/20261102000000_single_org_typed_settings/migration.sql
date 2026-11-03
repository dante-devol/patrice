-- Single-org: drop the organization_id seam and replace the organization row's
-- untyped settings blob with typed columns (redesign plan, Phase 0 items 7–8).

-- 1. Typed settings. Exactly one row (id = 1), seeded from the old organization row.
CREATE TABLE "system_settings" (
    "id"                               INTEGER NOT NULL DEFAULT 1,
    "org_name"                         TEXT NOT NULL DEFAULT 'Patrice',
    "config_version"                   BIGINT NOT NULL DEFAULT 0,
    "require_verified_email_to_log_in" BOOLEAN NOT NULL DEFAULT false,
    "self_review_allowed"              BOOLEAN NOT NULL DEFAULT false,
    "anonymize_label"                  BOOLEAN NOT NULL DEFAULT false,
    "session_absolute_days"            INTEGER NOT NULL DEFAULT 30,
    "session_idle_days"                INTEGER NOT NULL DEFAULT 7,
    "grace_period_hours"               INTEGER NOT NULL DEFAULT 24,
    "require_discord_link"             BOOLEAN NOT NULL DEFAULT false,
    "discord_client_id"                TEXT,
    "created_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_settings_singleton" CHECK ("id" = 1),
    CONSTRAINT "system_settings_session_days" CHECK ("session_absolute_days" >= 1 AND "session_idle_days" >= 1),
    CONSTRAINT "system_settings_grace" CHECK ("grace_period_hours" >= 0)
);

INSERT INTO "system_settings" (
    "id", "org_name", "config_version",
    "require_verified_email_to_log_in", "self_review_allowed", "anonymize_label",
    "session_absolute_days", "session_idle_days", "grace_period_hours",
    "require_discord_link", "discord_client_id", "created_at")
SELECT 1, o."name", o."config_version",
    COALESCE((o."settings"->>'requireVerifiedEmailToLogIn')::boolean, false),
    COALESCE((o."settings"->>'selfReviewAllowed')::boolean, false),
    COALESCE((o."settings"->>'anonymizeLabel')::boolean, false),
    COALESCE((o."settings"->>'sessionAbsoluteDays')::integer, 30),
    COALESCE((o."settings"->>'sessionIdleDays')::integer, 7),
    COALESCE((o."settings"->>'gracePeriodHours')::integer, 24),
    COALESCE((o."settings"->>'requireDiscordLink')::boolean, false),
    o."settings"->>'discordClientId',
    o."created_at"
FROM "organization" o;

INSERT INTO "system_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;

-- 2. Secrets live apart from settings, one row per purpose.
CREATE TABLE "secret" (
    "purpose"    TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "secret_pkey" PRIMARY KEY ("purpose")
);

INSERT INTO "secret" ("purpose", "ciphertext")
SELECT 'discord_oauth_client_secret', o."settings"->>'discordClientSecret'
FROM "organization" o
WHERE o."settings"->>'discordClientSecret' IS NOT NULL;

-- 3. Indexes and constraints that included organization_id are rebuilt without it.
DROP INDEX "app_user_organization_id_email_key";
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

DROP INDEX "integration_connection_organization_id_provider_external_workspace_id_key";
CREATE UNIQUE INDEX "integration_connection_provider_external_workspace_id_key"
    ON "integration_connection"("provider", "external_workspace_id");

-- At most one un-revoked system (bootstrap) invitation.
DROP INDEX "one_bootstrap_invite";
CREATE UNIQUE INDEX "one_bootstrap_invite" ON "invitation" ((true))
    WHERE "created_by" IS NULL AND "revoked_at" IS NULL;

-- 4. Drop the column everywhere (its FKs and plain indexes go with it).
ALTER TABLE "app_user"               DROP COLUMN "organization_id";
ALTER TABLE "invitation"             DROP COLUMN "organization_id";
ALTER TABLE "role"                   DROP COLUMN "organization_id";
ALTER TABLE "grant"                  DROP COLUMN "organization_id";
ALTER TABLE "activity"               DROP COLUMN "organization_id";
ALTER TABLE "division"               DROP COLUMN "organization_id";
ALTER TABLE "team"                   DROP COLUMN "organization_id";
ALTER TABLE "request_template"       DROP COLUMN "organization_id";
ALTER TABLE "task"                   DROP COLUMN "organization_id";
ALTER TABLE "attachment"             DROP COLUMN "organization_id";
ALTER TABLE "notification"           DROP COLUMN "organization_id";
ALTER TABLE "integration_connection" DROP COLUMN "organization_id";

DROP TABLE "organization";
