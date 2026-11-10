import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const guildQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().optional(),
});

const playerCountServerBodySchema = z.object({
  id: z.string().optional(),
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  name: z.string().min(1),
  provider: z.enum(["steam-web", "wardogs-rcon"]),
  providerServerId: z.string(),
  confirmReplacement: z.boolean().optional(),
  channelId: z.string().nullable().optional(),
  alertChannelId: z.string().nullable().optional(),
  refreshIntervalMinutes: z.number().int().min(5).max(60).optional(),
  displayFormat: z.string().optional(),
  offlineFormat: z.string().optional(),
  failureThreshold: z.number().int().min(1).max(20).optional(),
  steamHost: z.string().nullable().optional(),
  steamPort: z.number().int().nullable().optional(),
});

const playerCountDeleteBodySchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
});

const playerCountTestBodySchema = z.object({
  serverId: z.string().min(1),
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
});

const playerCountServerSchema = z.object({
  enabled: z.boolean().optional(),
  readiness: z.enum(["ready", "dormant"]).optional(),
  readinessMessage: z.string().optional(),
  id: z.string(),
  guildId: z.string(),
  name: z.string(),
  provider: z.enum(["steam-web", "wardogs-rcon"]),
  providerServerId: z.string(),
  channelId: z.string().nullable(),
  alertChannelId: z.string().nullable(),
  refreshIntervalMinutes: z.number().int(),
  displayFormat: z.string(),
  offlineFormat: z.string(),
  failureThreshold: z.number().int(),
  renameOffsetMinutes: z.number().int(),
  lastRenamedAtMs: z.number().int().nullable(),
  lastPlayerCount: z.number().int().nullable(),
  lastMaxSlots: z.number().int().nullable(),
  lastQueueSize: z.number().int().nullable(),
  lastFetchedAtMs: z.number().int().nullable(),
  steamHost: z.string().nullable(),
  steamPort: z.number().int().nullable(),
  consecutiveFailureCount: z.number().int(),
  lastErrorMessage: z.string().nullable(),
  lastErrorAtMs: z.number().int().nullable(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});

const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.entitlementRequired,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [
  ...readErrors,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.conflict,
] as const;
const metadata = {
  tags: ["Player Count"],
  feature: "playerCount",
  entitlement: "premium-only-features",
} as const;

export const getPlayerCount = defineAdminOperation({
  ...metadata,
  operationId: "playerCount.get",
  method: "GET",
  path: "/admin/api/player-count",
  summary: "List Player Count servers",
  query: guildQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      servers: z.array(playerCountServerSchema),
      wardogs: z
        .object({
          enabled: z.boolean(),
          targets: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              ready: z.boolean(),
              reason: z.string().optional(),
            }),
          ),
        })
        .optional(),
    }),
    description: "Configured Player Count servers for the Guild",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const savePlayerCountServer = defineAdminOperation({
  ...metadata,
  operationId: "playerCountServer.post",
  method: "POST",
  path: "/admin/api/player-count/server",
  summary: "Save a Player Count server",
  body: playerCountServerBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Player Count server was saved",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const deletePlayerCountServer = defineAdminOperation({
  ...metadata,
  operationId: "playerCountDelete.post",
  method: "POST",
  path: "/admin/api/player-count/delete",
  summary: "Delete a Player Count server",
  body: playerCountDeleteBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Player Count server was deleted",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const testPlayerCount = defineAdminOperation({
  ...metadata,
  operationId: "playerCountTest.post",
  method: "POST",
  path: "/admin/api/player-count/test",
  summary: "Test a Player Count server",
  body: playerCountTestBodySchema,
  success: {
    status: 200,
    schema: z.union([
      z.object({
        ok: z.literal(true),
        snapshot: z.object({
          count: z.number(),
          maxSlots: z.number(),
          queue: z.number().nullable(),
        }),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    description: "The Player Count reachability result",
  },
  errors: [...readErrors, adminOperationErrors.resourceNotFound],
  access: { scope: "guild", mode: "read" },
});

export const setPlayerCountEnabled = defineAdminOperation({
  ...metadata,
  operationId: "playerCountEnabled.post",
  method: "POST",
  path: "/admin/api/player-count/enabled",
  summary: "Enable or disable saved configuration",
  body: z.object({
    guildId: z.string().min(1),
    workspaceId: z.string().optional(),
    enabled: z.boolean(),
    id: z.string().min(1),
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

export const playerCountContracts = {
  setEnabled: setPlayerCountEnabled,
  get: getPlayerCount,
  save: savePlayerCountServer,
  delete: deletePlayerCountServer,
  test: testPlayerCount,
} as const;
