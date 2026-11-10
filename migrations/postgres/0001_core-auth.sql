-- Initial provider-neutral runtime schema. This is intentionally independent
-- from the D1 migration history and contains only the first ported domains.

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "emailVerified" BOOLEAN NOT NULL,
  "image" TEXT,
  "discordUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");
CREATE UNIQUE INDEX "User_discordUserId_key" ON "User" ("discordUserId");

CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY,
  "token" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "activeOrganizationId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "Session_token_key" ON "Session" ("token");

CREATE TABLE "Account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "Verification" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ
);

CREATE TABLE "Organization" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "logo" TEXT,
  "metadata" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization" ("slug");

CREATE TABLE "Member" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL
);

CREATE TABLE "Invitation" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "email" TEXT NOT NULL,
  "role" TEXT,
  "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "inviterId" TEXT NOT NULL
);

CREATE TABLE "WorkspaceGuild" (
  "workspaceId" TEXT NOT NULL REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "guildId" TEXT NOT NULL,
  "linkedByUserId" TEXT NOT NULL,
  "linkedAtMs" BIGINT NOT NULL,
  PRIMARY KEY ("workspaceId", "guildId")
);
CREATE UNIQUE INDEX "WorkspaceGuild_guildId_key" ON "WorkspaceGuild" ("guildId");

CREATE TABLE "WorkspaceGuildAuditEvent" (
  "id" TEXT PRIMARY KEY,
  "workspaceId" TEXT NOT NULL REFERENCES "Organization" ("id") ON DELETE CASCADE,
  "guildId" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('linked', 'unlinked')),
  "actorUserId" TEXT NOT NULL,
  "occurredAtMs" BIGINT NOT NULL,
  "previousWorkspaceId" TEXT
);
CREATE INDEX "WorkspaceGuildAuditEvent_workspace_time_idx"
  ON "WorkspaceGuildAuditEvent" ("workspaceId", "occurredAtMs");
CREATE INDEX "WorkspaceGuildAuditEvent_guild_time_idx"
  ON "WorkspaceGuildAuditEvent" ("guildId", "occurredAtMs");

CREATE TABLE "WorkspaceEntitlement" (
  "workspaceId" TEXT PRIMARY KEY REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "plan" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "enabledFlagsJson" TEXT NOT NULL,
  "updatedAtMs" BIGINT NOT NULL
);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE guild_rbac_settings (
  guild_id TEXT PRIMARY KEY,
  guild_admin_role_id TEXT
);

CREATE TABLE known_guilds (
  guild_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT NOT NULL DEFAULT '',
  icon TEXT,
  installed_at_ms BIGINT NOT NULL,
  removed_at_ms BIGINT
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY,
  hidden_guild_ids_json TEXT NOT NULL DEFAULT '[]',
  default_guild_id TEXT,
  email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  push_notifications BOOLEAN NOT NULL DEFAULT FALSE,
  compact_mode BOOLEAN NOT NULL DEFAULT FALSE,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es', 'de', 'fr')),
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE guild_service_suspensions (
  guild_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  removed_at_ms BIGINT,
  removed_by_user_id TEXT
);
CREATE INDEX guild_service_suspensions_created_idx
  ON guild_service_suspensions (created_at_ms DESC);

CREATE TABLE guild_service_suspension_audit (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('suspended', 'restored')),
  reason TEXT,
  actor_user_id TEXT NOT NULL,
  occurred_at_ms BIGINT NOT NULL
);
CREATE INDEX guild_service_suspension_audit_guild_time_idx
  ON guild_service_suspension_audit (guild_id, occurred_at_ms);
