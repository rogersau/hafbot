import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const platforms = ["steam", "xbox", "playstation"] as const;
const platformSchema = z.enum(platforms);
const optionalWorkspaceId = z.string().optional();
const playerLinkQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: optionalWorkspaceId,
  platform: platformSchema.optional(),
});

const customLinkSchema = z.object({ label: z.string(), url: z.string() });
const playerLinkConfigBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceId,
  platform: platformSchema,
  linkedRoleId: z.string().nullable().optional(),
  logChannelId: z.string().nullable().optional(),
  gameAppIds: z.array(z.string()).optional(),
  panelTitle: z.string().min(1),
  panelDescription: z.string().min(1),
  panelButtonLabel: z.string().min(1),
  panelButtonStyle: z.enum(["Primary", "Secondary", "Success", "Danger"]),
  panelColor: z.number().int().min(0).max(0xffffff).optional(),
  allowRelink: z.boolean(),
  allowMultipleLinks: z.boolean().optional(),
  requireRelinkOnRejoin: z.boolean().optional(),
  whoisFields: z.array(z.string()).optional(),
  customLinks: z.array(customLinkSchema).optional(),
});

const playerLinkPublishBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceId,
  platform: platformSchema,
  panelChannelId: z.string().min(1),
});

const playerLinkSyncRolesBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: optionalWorkspaceId,
  platform: platformSchema,
});

const platformLinkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  guildId: z.string(),
  platform: platformSchema,
  linkedRoleId: z.string().nullable(),
  logChannelId: z.string().nullable(),
  gameAppIds: z.array(z.number().int()),
  panelTitle: z.string(),
  panelDescription: z.string(),
  panelButtonLabel: z.string(),
  panelButtonStyle: z.string(),
  panelColor: z.number().int().optional(),
  allowRelink: z.boolean(),
  allowMultipleLinks: z.boolean(),
  requireRelinkOnRejoin: z.boolean(),
  whoisFields: z.array(z.string()),
  customLinks: z.array(customLinkSchema),
  panelChannelId: z.string().nullable(),
  panelMessageId: z.string().nullable(),
  updatedAtMs: z.number().int(),
});
const platformLinkSchema = z.object({
  guildId: z.string(),
  userId: z.string(),
  platform: platformSchema,
  platformId: z.string(),
  linkedAtMs: z.number().int(),
  manual: z.boolean(),
  actionedByUserId: z.string().nullable(),
  metadataJson: z.string().nullable(),
  active: z.boolean(),
});
const playerLinkResponseSchema = z.object({
  guildId: z.string(),
  platform: platformSchema,
  config: platformLinkConfigSchema.nullable(),
  links: z.array(platformLinkSchema),
});

const syncResponseSchema = z.object({
  ok: z.literal(true),
  total: z.number().int(),
  fixed: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [
  ...readErrors,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.conflict,
] as const;
const paidMetadata = {
  tags: ["Player Link"],
  feature: "steamLink",
  entitlement: "premium-only-features",
} as const;
const playerLinkMetadata = {
  tags: ["Player Link"],
  feature: "steamLink",
  entitlement: undefined,
} as const;

export const getPlayerLink = defineAdminOperation({
  ...paidMetadata,
  operationId: "playerLink.get",
  method: "GET",
  path: "/admin/api/player-link",
  summary: "List Player Links and configuration",
  query: playerLinkQuerySchema,
  success: {
    status: 200,
    schema: playerLinkResponseSchema,
    description: "Player Link configuration and linked accounts",
  },
  errors: [...readErrors, adminOperationErrors.entitlementRequired],
  access: { scope: "guild", mode: "read" },
});
export const savePlayerLink = defineAdminOperation({
  ...paidMetadata,
  operationId: "playerLinkConfig.post",
  method: "POST",
  path: "/admin/api/player-link/config",
  summary: "Save Player Link configuration",
  body: playerLinkConfigBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "Player Link configuration was saved",
  },
  errors: [...writeErrors, adminOperationErrors.entitlementRequired],
  access: { scope: "guild", mode: "write" },
});
export const publishPlayerLink = defineAdminOperation({
  ...paidMetadata,
  operationId: "playerLinkPublish.post",
  method: "POST",
  path: "/admin/api/player-link/publish",
  summary: "Publish a Player Link panel",
  body: playerLinkPublishBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), panelMessageId: z.string() }),
    description: "The Player Link panel message",
  },
  errors: [...writeErrors, adminOperationErrors.entitlementRequired],
  access: { scope: "guild", mode: "write" },
});
export const syncPlayerLinkRoles = defineAdminOperation({
  ...paidMetadata,
  operationId: "playerLinkSyncRoles.post",
  method: "POST",
  path: "/admin/api/player-link/sync-roles",
  summary: "Synchronize Player Link roles",
  body: playerLinkSyncRolesBodySchema,
  success: {
    status: 200,
    schema: syncResponseSchema,
    description: "Player Link role synchronization counts",
  },
  errors: [...writeErrors, adminOperationErrors.entitlementRequired],
  access: { scope: "guild", mode: "write" },
});

export const setPlayerLinkEnabled = defineAdminOperation({
  ...playerLinkMetadata,
  operationId: "playerLinkEnabled.post",
  method: "POST",
  path: "/admin/api/player-link/enabled",
  summary: "Enable or disable saved configuration",
  body: z.object({
    guildId: z.string().min(1),
    workspaceId: z.string().optional(),
    enabled: z.boolean(),
    platform: platformSchema,
  }),
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "Availability was updated; configuration is retained",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
  entitlement: undefined,
});

export const playerLinkContracts = {
  setEnabled: setPlayerLinkEnabled,
  get: getPlayerLink,
  save: savePlayerLink,
  publish: publishPlayerLink,
  syncRoles: syncPlayerLinkRoles,
} as const;
