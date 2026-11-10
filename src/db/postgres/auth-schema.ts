import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const dateTime = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const milliseconds = (name: string) => bigint(name, { mode: "number" });

export const user = pgTable(
  "User",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("emailVerified").notNull(),
    image: text("image"),
    discordUserId: text("discordUserId").notNull(),
    createdAt: dateTime("createdAt").notNull(),
    updatedAt: dateTime("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("User_email_key").on(table.email),
    uniqueIndex("User_discordUserId_key").on(table.discordUserId),
  ],
);

export const session = pgTable(
  "Session",
  {
    id: text("id").primaryKey().notNull(),
    token: text("token").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "cascade" }),
    expiresAt: dateTime("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    activeOrganizationId: text("activeOrganizationId"),
    createdAt: dateTime("createdAt").notNull(),
    updatedAt: dateTime("updatedAt").notNull(),
  },
  (table) => [uniqueIndex("Session_token_key").on(table.token)],
);

export const account = pgTable("Account", {
  id: text("id").primaryKey().notNull(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade", onUpdate: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: dateTime("accessTokenExpiresAt"),
  refreshTokenExpiresAt: dateTime("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: dateTime("createdAt").notNull(),
  updatedAt: dateTime("updatedAt").notNull(),
});

export const verification = pgTable("Verification", {
  id: text("id").primaryKey().notNull(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: dateTime("expiresAt").notNull(),
  createdAt: dateTime("createdAt"),
  updatedAt: dateTime("updatedAt"),
});

export const organization = pgTable(
  "Organization",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: dateTime("createdAt").notNull(),
  },
  (table) => [uniqueIndex("Organization_slug_key").on(table.slug)],
);

export const member = pgTable("Member", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade", onUpdate: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade", onUpdate: "cascade" }),
  role: text("role").notNull(),
  createdAt: dateTime("createdAt").notNull(),
});

export const invitation = pgTable("Invitation", {
  id: text("id").primaryKey().notNull(),
  organizationId: text("organizationId")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade", onUpdate: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: dateTime("expiresAt").notNull(),
  createdAt: dateTime("createdAt").defaultNow().notNull(),
  inviterId: text("inviterId").notNull(),
});

export const workspaceGuild = pgTable(
  "WorkspaceGuild",
  {
    workspaceId: text("workspaceId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade", onUpdate: "cascade" }),
    guildId: text("guildId").notNull(),
    linkedByUserId: text("linkedByUserId").notNull(),
    linkedAtMs: milliseconds("linkedAtMs").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.guildId] }),
    uniqueIndex("WorkspaceGuild_guildId_key").on(table.guildId),
  ],
);

export const workspaceGuildAuditEvent = pgTable(
  "WorkspaceGuildAuditEvent",
  {
    id: text("id").primaryKey().notNull(),
    workspaceId: text("workspaceId")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    guildId: text("guildId").notNull(),
    action: text("action", { enum: ["linked", "unlinked"] }).notNull(),
    actorUserId: text("actorUserId").notNull(),
    occurredAtMs: milliseconds("occurredAtMs").notNull(),
    previousWorkspaceId: text("previousWorkspaceId"),
  },
  (table) => [
    index("WorkspaceGuildAuditEvent_workspace_time_idx").on(table.workspaceId, table.occurredAtMs),
    index("WorkspaceGuildAuditEvent_guild_time_idx").on(table.guildId, table.occurredAtMs),
  ],
);

export const workspaceEntitlement = pgTable("WorkspaceEntitlement", {
  workspaceId: text("workspaceId")
    .primaryKey()
    .notNull()
    .references(() => organization.id, { onDelete: "cascade", onUpdate: "cascade" }),
  plan: text("plan").notNull(),
  status: text("status").notNull(),
  enabledFlagsJson: text("enabledFlagsJson").notNull(),
  updatedAtMs: milliseconds("updatedAtMs").notNull(),
});
