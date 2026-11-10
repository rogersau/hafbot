import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";
import { operationalIncidentViewSchema } from "./operations-incidents";

const guildPlanSchema = z.enum(["free", "premium", "premium_plus"]);
const workspaceRoleSchema = z.enum(["owner", "admin", "viewer"]);
const emptyQuerySchema = z.object({});
const guildQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});
const workspaceQuerySchema = z.object({ workspaceId: z.string().min(1) });
const crossReadErrors = [
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const crossWriteErrors = [
  adminOperationErrors.invalidRequest,
  ...crossReadErrors,
  adminOperationErrors.conflict,
] as const;
const metadata = { tags: ["Cross-Cutting"], feature: undefined, entitlement: undefined } as const;

const userPreferencesSchema = z.object({
  hiddenGuildIds: z.array(z.string()),
  defaultGuildId: z.string().nullable(),
  emailNotifications: z.boolean(),
  pushNotifications: z.boolean(),
  theme: z.enum(["system", "light", "dark"]),
  language: z.enum(["en", "es", "de", "fr"]),
});
const userPreferencesPatchSchema = z
  .object({
    hiddenGuildIds: z.array(z.string().min(1)).max(500).optional(),
    defaultGuildId: z.string().min(1).nullable().optional(),
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    language: z.enum(["en", "es", "de", "fr"]).optional(),
  })
  .strict();

export const getProfilePreferences = defineAdminOperation({
  ...metadata,
  operationId: "profilePreferences.get",
  method: "GET",
  path: "/admin/api/profile/preferences",
  query: emptyQuerySchema,
  summary: "Read Admin profile preferences",
  success: {
    status: 200,
    schema: userPreferencesSchema,
    description: "The current profile preferences",
  },
  errors: crossReadErrors,
  access: { scope: "customer", mode: "read" },
});

export const patchProfilePreferences = defineAdminOperation({
  ...metadata,
  operationId: "profilePreferences.patch",
  method: "PATCH",
  path: "/admin/api/profile/preferences",
  body: userPreferencesPatchSchema,
  summary: "Update Admin profile preferences",
  success: {
    status: 200,
    schema: userPreferencesSchema,
    description: "The updated profile preferences",
  },
  errors: crossWriteErrors,
  access: { scope: "customer", mode: "write" },
});

const entitlementLimitsSchema = z.object({
  blocklistMaxEmojis: z.number().int().nullable(),
  reactionLimitsEnabled: z.boolean(),
  ticketsMaxPanels: z.number().int().nullable(),
  ticketsMaxTypesPerPanel: z.number().int().nullable(),
  platformLinkMaxLinks: z.number().int().nullable(),
  managedMessagesMax: z.number().int().nullable(),
  clansMax: z.number().int().nullable(),
  clanMembersMax: z.number().int().nullable(),
  clanOfficersMax: z.number().int().nullable(),
  messageTemplatesMax: z.number().int().nullable(),
  evidenceVaultMaxRecords: z.number().int().nullable(),
  r2MaxBytes: z.number().int(),
  paidFeatures: z.boolean(),
});

export const getEntitlement = defineAdminOperation({
  ...metadata,
  operationId: "entitlement.get",
  method: "GET",
  path: "/admin/api/entitlement",
  query: guildQuerySchema,
  summary: "Read Guild entitlement",
  success: {
    status: 200,
    schema: z.object({
      tier: guildPlanSchema,
      limits: entitlementLimitsSchema,
      supportInvite: z.string().nullable(),
      r2Usage: z.object({
        usedBytes: z.number().int().nonnegative(),
        reservedBytes: z.number().int().nonnegative(),
        maxBytes: z.number().int().nonnegative(),
        lastReconciledAtMs: z.number().int().nullable(),
      }),
    }),
    description: "The Guild plan, feature limits, and storage usage",
  },
  errors: crossReadErrors,
  access: { scope: "guild", mode: "read" },
});

const overviewCardSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  status: z.enum(["configured", "not-set-up", "requires-paid-plan", "attention"]),
  detail: z.string().nullable(),
  locked: z.boolean(),
  attentionCount: z.number().int().nonnegative().optional(),
  highestSeverity: z.enum(["warning", "error", "critical"]).optional(),
  attentionSummary: z.string().nullable().optional(),
  setupHref: z.string().nullable().optional(),
  readiness: z
    .enum([
      "not_setup",
      "setup_incomplete",
      "ready_disabled",
      "enabled",
      "needs_attention",
      "dormant",
    ])
    .optional(),
});

export const getGuildOverview = defineAdminOperation({
  ...metadata,
  operationId: "guildOverview.get",
  method: "GET",
  path: "/admin/api/guild-overview",
  query: guildQuerySchema,
  summary: "Read Guild feature overview",
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      tier: guildPlanSchema,
      cards: z.array(overviewCardSchema),
      recommendedNextStep: z
        .object({
          featureId: z.string(),
          title: z.string(),
          description: z.string(),
          ctaHref: z.string(),
        })
        .nullable()
        .optional(),
      operations: z.object({ openIncidents: z.array(operationalIncidentViewSchema) }).optional(),
    }),
    description: "The Guild feature status cards and recommended next step",
  },
  errors: crossReadErrors,
  access: { scope: "guild", mode: "read" },
});

const directoryEntrySchema = z.object({
  guildId: z.string(),
  name: z.string(),
  label: z.string(),
  icon: z.string().nullable(),
});

export const getGuildDirectory = defineAdminOperation({
  ...metadata,
  operationId: "guildDirectory.get",
  method: "GET",
  path: "/admin/api/guilds",
  query: z.object({
    workspaceId: z.string().min(1).optional(),
    refresh: z.literal("1").optional(),
  }),
  summary: "List authorized Guilds",
  success: {
    status: 200,
    schema: z.object({ guilds: z.array(directoryEntrySchema) }),
    description: "Guilds available to the customer",
  },
  errors: [...crossReadErrors, adminOperationErrors.discordRateLimited],
  access: { scope: "customer", mode: "read" },
});

const gatewaySnapshotSchema = z.object({
  status: z.enum(["idle", "connecting", "ready", "resuming", "backoff"]),
  sessionId: z.string().nullable(),
  resumeGatewayUrl: z.string().nullable(),
  lastSequence: z.number().int().nullable(),
  backoffAttempt: z.number().int(),
  lastError: z.string().nullable(),
  heartbeatIntervalMs: z.number().int().nullable(),
});
const overviewGuildSchema = z.object({
  guildId: z.string(),
  emojis: z.array(z.string()),
  timedRoles: z.array(
    z.object({
      guildId: z.string(),
      userId: z.string(),
      roleId: z.string(),
      targetDisplayName: z.string().nullable().optional(),
      durationInput: z.string(),
      expiresAtMs: z.number().int(),
      suspendedRoleIds: z.array(z.string()).optional(),
      pendingSuspensionRoleIds: z.array(z.string()).optional(),
      removedRoleIds: z.array(z.string()).optional(),
      pendingRestorationRoleIds: z.array(z.string()).optional(),
      restorationStartedAtMs: z.number().int().nullable().optional(),
      targetRoleRemovalCompletedAtMs: z.number().int().nullable().optional(),
    }),
  ),
  roleNamesById: z.object({}).passthrough(),
});

export const getAdminOverview = defineAdminOperation({
  ...metadata,
  operationId: "adminOverview.get",
  method: "GET",
  path: "/admin/api/overview",
  query: z.object({
    workspaceId: z.string().min(1).optional(),
    refresh: z.literal("1").optional(),
  }),
  summary: "Read Admin overview",
  success: {
    status: 200,
    schema: z.object({
      gateway: z.union([z.array(gatewaySnapshotSchema), z.object({}).passthrough()]),
      guilds: z.array(overviewGuildSchema),
    }),
    description: "Gateway status and cross-Guild overview data",
  },
  errors: crossReadErrors,
  access: { scope: "customer", mode: "read" },
});

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: workspaceRoleSchema,
});
const workspaceGuildSchema = z.object({
  workspaceId: z.string(),
  guildId: z.string(),
  linkedByUserId: z.string(),
  linkedAtMs: z.number().int(),
});
const workspaceGuildBodySchema = z.object({
  workspaceId: z.string().min(1),
  guildId: z.string().min(1),
});

export const listWorkspaces = defineAdminOperation({
  ...metadata,
  operationId: "workspaces.get",
  method: "GET",
  path: "/admin/api/workspaces",
  query: emptyQuerySchema,
  summary: "List Workspaces",
  success: {
    status: 200,
    schema: z.object({ workspaces: z.array(workspaceSchema) }),
    description: "Workspaces available to the customer",
  },
  errors: crossReadErrors,
  access: { scope: "workspace", mode: "read" },
});

export const listWorkspaceGuilds = defineAdminOperation({
  ...metadata,
  operationId: "workspaceGuilds.get",
  method: "GET",
  path: "/admin/api/workspace-guilds",
  query: workspaceQuerySchema,
  summary: "List Workspace Guilds",
  success: {
    status: 200,
    schema: z.object({ workspaceId: z.string(), guilds: z.array(workspaceGuildSchema) }),
    description: "Guilds linked to a Workspace",
  },
  errors: [...crossReadErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "workspace", mode: "read" },
});

export const linkWorkspaceGuild = defineAdminOperation({
  ...metadata,
  operationId: "workspaceGuilds.post",
  method: "POST",
  path: "/admin/api/workspace-guilds",
  body: workspaceGuildBodySchema,
  summary: "Link a Guild to a Workspace",
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Guild was linked",
  },
  errors: [...crossWriteErrors, adminOperationErrors.permissionDenied],
  access: { scope: "workspace", mode: "write" },
});

export const unlinkWorkspaceGuild = defineAdminOperation({
  ...metadata,
  operationId: "workspaceGuildsDelete.post",
  method: "POST",
  path: "/admin/api/workspace-guilds/delete",
  body: workspaceGuildBodySchema,
  summary: "Unlink a Guild from a Workspace",
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Guild was unlinked",
  },
  errors: [...crossWriteErrors, adminOperationErrors.permissionDenied],
  access: { scope: "workspace", mode: "write" },
});

export const getGuildAdminRole = defineAdminOperation({
  ...metadata,
  operationId: "guildRbacAdminRole.get",
  method: "GET",
  path: "/admin/api/guild-rbac/admin-role",
  query: guildQuerySchema,
  summary: "Read the Guild Admin role",
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      adminRoleId: z.string().nullable(),
      manageServerAdminEnabled: z.boolean(),
      canManageDelegation: z.boolean(),
      canManageServerPolicy: z.boolean(),
    }),
    description: "The configured Guild Admin role",
  },
  errors: crossReadErrors,
  access: { scope: "guild", mode: "read" },
});

export const saveGuildAdminRole = defineAdminOperation({
  ...metadata,
  operationId: "guildRbacAdminRole.post",
  method: "POST",
  path: "/admin/api/guild-rbac/admin-role",
  body: z
    .object({
      guildId: z.string().min(1),
      workspaceId: z.string().min(1).optional(),
      manageServerAdminEnabled: z.boolean().optional(),
      adminRoleId: z
        .string()
        .regex(/^\d{17,20}$/, "adminRoleId must be a Discord role ID")
        .nullable()
        .optional(),
    })
    .refine(
      (value) => value.adminRoleId !== undefined || value.manageServerAdminEnabled !== undefined,
      "Choose an access setting to update",
    ),
  summary: "Update guild administration access",
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      adminRoleId: z.string().nullable(),
      manageServerAdminEnabled: z.boolean(),
    }),
    description: "The Guild Admin role was saved",
  },
  errors: crossWriteErrors,
  access: { scope: "guild", mode: "write" },
});

const productAnalyticsPreferenceSchema = z.object({
  guildId: z.string(),
  enabled: z.boolean(),
});

export const getProductAnalyticsPreference = defineAdminOperation({
  ...metadata,
  operationId: "productAnalyticsPreference.get",
  method: "GET",
  path: "/admin/api/product-analytics/preference",
  query: guildQuerySchema,
  summary: "Read the Guild product analytics preference",
  success: {
    status: 200,
    schema: productAnalyticsPreferenceSchema,
    description: "The Guild product analytics preference",
  },
  errors: crossReadErrors,
  access: { scope: "guild", mode: "read" },
});

export const saveProductAnalyticsPreference = defineAdminOperation({
  ...metadata,
  operationId: "productAnalyticsPreference.post",
  method: "POST",
  path: "/admin/api/product-analytics/preference",
  body: z
    .object({
      guildId: z.string().min(1),
      workspaceId: z.string().min(1).optional(),
      enabled: z.boolean(),
    })
    .strict(),
  summary: "Save the Guild product analytics preference",
  success: {
    status: 200,
    schema: productAnalyticsPreferenceSchema,
    description: "The Guild product analytics preference was saved",
  },
  errors: crossWriteErrors,
  access: { scope: "guild", mode: "write" },
});

const productFeatureSchema = z.enum([
  "reaction_rules",
  "tickets",
  "lfg",
  "member_verification",
  "player_link",
  "server_levels",
]);
const productFailureCodeSchema = z.enum([
  "discord_rejected",
  "discord_unavailable",
  "invalid_configuration",
  "provider_rejected",
  "provider_unavailable",
  "storage_unavailable",
]);
const analyticsGuildBodySchema = {
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
};

export const createDashboardProductAnalyticsEvent = defineAdminOperation({
  ...metadata,
  operationId: "productAnalyticsEvent.post",
  method: "POST",
  path: "/admin/api/product-analytics/events",
  body: z.discriminatedUnion("event", [
    z
      .object({
        ...analyticsGuildBodySchema,
        event: z.literal("page_viewed"),
        page: z.enum([
          "overview",
          "guild_settings",
          "reaction_rules",
          "tickets",
          "lfg",
          "member_verification",
          "player_link",
          "server_levels",
          "billing",
          "other",
        ]),
        feature: productFeatureSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...analyticsGuildBodySchema,
        event: z.literal("milestone"),
        action: z.enum([
          "guild_selected",
          "onboarding_goal_selected",
          "resource_setup_started",
          "resource_setup_completed",
          "configuration_saved",
          "feature_enabled",
          "feature_disabled",
          "onboarding_verification_completed",
          "upgrade_viewed",
          "upgrade_started",
          "help_opened",
        ]),
        feature: productFeatureSchema.optional(),
        status: z.enum(["success", "failure"]).optional(),
        reasonCode: productFailureCodeSchema.optional(),
      })
      .strict(),
  ]),
  summary: "Submit an allowlisted Dashboard product event",
  success: {
    status: 202,
    schema: z.object({ accepted: z.literal(true) }),
    description: "The event was accepted or privacy-suppressed",
  },
  errors: crossWriteErrors,
  access: { scope: "guild", mode: "write" },
});

export const crossCuttingContracts = {
  adminOverview: getAdminOverview,
  entitlement: getEntitlement,
  guildDirectory: getGuildDirectory,
  guildOverview: getGuildOverview,
  guildRbacGet: getGuildAdminRole,
  guildRbacPost: saveGuildAdminRole,
  productAnalyticsPreferenceGet: getProductAnalyticsPreference,
  productAnalyticsPreferencePost: saveProductAnalyticsPreference,
  productAnalyticsEventPost: createDashboardProductAnalyticsEvent,
  profileGet: getProfilePreferences,
  profilePatch: patchProfilePreferences,
  workspaceGuildsGet: listWorkspaceGuilds,
  workspaceGuildsPost: linkWorkspaceGuild,
  workspaceGuildsDelete: unlinkWorkspaceGuild,
  workspaces: listWorkspaces,
} as const;
