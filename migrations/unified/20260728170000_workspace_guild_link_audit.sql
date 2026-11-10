-- hafbot:migration {"phase":"expand"}

CREATE TABLE "WorkspaceGuildAuditEvent" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "action" TEXT NOT NULL CHECK ("action" IN ('linked', 'unlinked')),
    "actorUserId" TEXT NOT NULL,
    "occurredAtMs" INTEGER NOT NULL,
    "previousWorkspaceId" TEXT,
    CONSTRAINT "WorkspaceGuildAuditEvent_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Organization" ("id")
      ON DELETE CASCADE
);

CREATE INDEX "WorkspaceGuildAuditEvent_workspace_time_idx"
  ON "WorkspaceGuildAuditEvent" ("workspaceId", "occurredAtMs");

CREATE INDEX "WorkspaceGuildAuditEvent_guild_time_idx"
  ON "WorkspaceGuildAuditEvent" ("guildId", "occurredAtMs");
