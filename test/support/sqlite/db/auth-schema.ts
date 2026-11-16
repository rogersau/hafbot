import {
  customType,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

const datetime = customType<{ data: Date; driverData: string | number | Date }>({
  dataType() {
    return "DATETIME";
  },
  fromDriver(value) {
    return value instanceof Date ? value : new Date(value);
  },
  toDriver(value) {
    return value.toISOString();
  },
});

export const user = sqliteTable(
  "User",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
    image: text("image"),
    discordUserId: text("discordUserId").notNull(),
    createdAt: datetime("createdAt").notNull(),
    updatedAt: datetime("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("User_email_key").on(table.email),
    uniqueIndex("User_discordUserId_key").on(table.discordUserId),
  ],
);

export const session = sqliteTable(
  "Session",
  {
    id: text("id").primaryKey().notNull(),
    token: text("token").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: datetime("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    activeOrganizationId: text("activeOrganizationId"),
    createdAt: datetime("createdAt").notNull(),
    updatedAt: datetime("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("Session_token_key").on(table.token)],
);

export const account = sqliteTable("Account", {
  id: text("id").primaryKey().notNull(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: datetime("accessTokenExpiresAt"),
  refreshTokenExpiresAt: datetime("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: datetime("createdAt").notNull(),
  updatedAt: datetime("updatedAt").notNull(),
});

export const verification = sqliteTable("Verification", {
  id: text("id").primaryKey().notNull(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: datetime("expiresAt").notNull(),
  createdAt: datetime("createdAt"),
  updatedAt: datetime("updatedAt"),
});

export const organization = sqliteTable(
  "Organization",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: datetime("createdAt").notNull(),
  },
  (table) => [uniqueIndex("Organization_slug_key").on(table.slug)],
);

export const member = sqliteTable("Member", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, {
      onDelete: "cascade",
    }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: datetime("createdAt").notNull(),
});

export const invitation = sqliteTable("Invitation", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, {
      onDelete: "cascade",
    }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: datetime("expiresAt").notNull(),
  createdAt: datetime("createdAt").notNull(),
  inviterId: text("inviterId").notNull(),
});

export const workspaceGuild = sqliteTable(
  "WorkspaceGuild",
  {
    workspaceId: text("workspaceId")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    guildId: text("guildId").notNull(),
    linkedByUserId: text("linkedByUserId").notNull(),
    linkedAtMs: integer("linkedAtMs").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.guildId] }),
    uniqueIndex("WorkspaceGuild_guildId_key").on(table.guildId),
  ],
);

export const workspaceGuildAuditEvent = sqliteTable(
  "WorkspaceGuildAuditEvent",
  {
    id: text("id").primaryKey().notNull(),
    workspaceId: text("workspaceId")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    guildId: text("guildId").notNull(),
    action: text("action", { enum: ["linked", "unlinked"] }).notNull(),
    actorUserId: text("actorUserId").notNull(),
    occurredAtMs: integer("occurredAtMs").notNull(),
    previousWorkspaceId: text("previousWorkspaceId"),
  },
  (table) => [
    index("WorkspaceGuildAuditEvent_workspace_time_idx").on(table.workspaceId, table.occurredAtMs),
    index("WorkspaceGuildAuditEvent_guild_time_idx").on(table.guildId, table.occurredAtMs),
  ],
);

export const workspaceEntitlement = sqliteTable("WorkspaceEntitlement", {
  workspaceId: text("workspaceId")
    .primaryKey()
    .notNull()
    .references(() => organization.id, {
      onDelete: "cascade",
    }),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  enabledFlagsJson: text("enabledFlagsJson").notNull(),
  updatedAtMs: integer("updatedAtMs").notNull(),
});
