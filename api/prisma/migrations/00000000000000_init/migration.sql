-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Extensions: citext for case-insensitive email; uuidv7() is a PostgreSQL 18 built-in.
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('active', 'deactivated', 'retired');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('password', 'google');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('password', 'google');

-- CreateEnum
CREATE TYPE "RoleKind" AS ENUM ('standalone', 'division', 'team');

-- CreateEnum
CREATE TYPE "GrantEffect" AS ENUM ('permit', 'forbid');

-- CreateEnum
CREATE TYPE "ScopeKind" AS ENUM ('global', 'own', 'own_division', 'own_team', 'specific_division', 'specific_team', 'role');

-- CreateEnum
CREATE TYPE "UserRoleSource" AS ENUM ('patrice', 'integration');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "ActivitySource" AS ENUM ('patrice', 'integration', 'system');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "config_version" BIGINT NOT NULL DEFAULT 0,
    "singleton" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email" TEXT,
    "display_name" TEXT NOT NULL,
    "created_via_invitation_id" UUID,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "deactivated_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identity" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_subject" TEXT,
    "password_hash" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "auth_method" "AuthMethod" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip" INET,
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT,
    "intended_role_ids" UUID[],
    "passcode_hash" TEXT,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_use" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "invitation_id" UUID NOT NULL,
    "created_user_id" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "kind" "AuthTokenKind" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "auth_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RoleKind" NOT NULL,
    "division_id" UUID,
    "team_id" UUID,
    "lifecycle_state" "LifecycleState" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "source" "UserRoleSource" NOT NULL DEFAULT 'patrice',
    "source_connection_id" UUID,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "effect" "GrantEffect" NOT NULL DEFAULT 'permit',
    "scope_kind" "ScopeKind" NOT NULL,
    "scope_division_id" UUID,
    "scope_team_id" UUID,
    "scope_role_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "verb" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" "ActivitySource" NOT NULL,
    "source_connection_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_singleton_key" ON "organization"("singleton");

-- CreateIndex
CREATE INDEX "app_user_organization_id_idx" ON "app_user"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_organization_id_email_key" ON "app_user"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_provider_provider_subject_key" ON "user_identity"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_user_id_provider_key" ON "user_identity"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_hash_key" ON "invitation"("token_hash");

-- CreateIndex
CREATE INDEX "invitation_organization_id_idx" ON "invitation"("organization_id");

-- CreateIndex
CREATE INDEX "invitation_use_invitation_id_idx" ON "invitation_use"("invitation_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_token_hash_key" ON "auth_token"("token_hash");

-- CreateIndex
CREATE INDEX "auth_token_user_id_idx" ON "auth_token"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_division_id_key" ON "role"("division_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_team_id_key" ON "role"("team_id");

-- CreateIndex
CREATE INDEX "role_organization_id_idx" ON "role"("organization_id");

-- CreateIndex
CREATE INDEX "user_role_role_id_idx" ON "user_role"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_user_id_role_id_key" ON "user_role"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "grant_organization_id_idx" ON "grant"("organization_id");

-- CreateIndex
CREATE INDEX "grant_role_id_idx" ON "grant"("role_id");

-- CreateIndex
CREATE INDEX "activity_subject_type_subject_id_created_at_idx" ON "activity"("subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_created_at_idx" ON "activity"("created_at");

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_use" ADD CONSTRAINT "invitation_use_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_use" ADD CONSTRAINT "invitation_use_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant" ADD CONSTRAINT "grant_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant" ADD CONSTRAINT "grant_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-applied: case-insensitive email (citext). Prisma models these as text; the
-- column type change makes UNIQUE(organization_id, email) case-insensitive at the DB.
ALTER TABLE "app_user" ALTER COLUMN "email" TYPE CITEXT;
ALTER TABLE "invitation" ALTER COLUMN "email" TYPE CITEXT;

-- Hand-applied: bootstrap-singleton. At most one un-revoked system invitation
-- (created_by IS NULL) may exist per organization, so two-instance boot cannot
-- duplicate the bootstrap invite (docs/slices/01 — partial unique index).
CREATE UNIQUE INDEX "one_bootstrap_invite" ON "invitation" ("organization_id")
  WHERE "created_by" IS NULL AND "revoked_at" IS NULL;

