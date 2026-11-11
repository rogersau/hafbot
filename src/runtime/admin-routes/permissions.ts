import type { Cache } from "../discord-json-cache";
import type { WardogsService } from "../../wardogs/service";
import { defineRoute, type Route } from "../admin-route-registry";
import { guildScopedAccess } from "../admin-route-guards";
import { type AdminAccess } from "../admin-access";
import type { RuntimeStores } from "../app-types";
import { z } from "zod";
import { bindAdminContract } from "../admin-contract-route";
import { getGuildDirectory } from "../../contracts/admin/cross-cutting";
import { DiscordApiError } from "../../discord";
import {
  buildBlocklistPermissionChecks,
  buildLfgPermissionChecks,
  buildMarketplacePermissionChecks,
  buildPlayerCountPermissionChecks,
  buildServerLevelsPermissionChecks,
  buildSteamLinkPermissionChecks,
  buildEvidenceVaultPermissionChecks,
  buildTicketPermissionChecks,
  buildTimedRolePermissionChecks,
  buildMentionProtectionPermissionChecks,
  buildManagedMessagePermissionChecks,
  buildMemberVerificationPermissionChecks,
  buildImageRulesPermissionChecks,
  buildBotDefensePermissionChecks,
  buildEventPermissionChecks,
  buildGuildAuditLogPermissionChecks,
  buildWebhookPermissionChecks,
  buildBanCasePermissionChecks,
} from "../admin-permissions";
import {
  getCachedBotGuilds,
  getCachedGuildPermissionContext,
  shouldRefreshAdminDiscordCache,
} from "../admin-discord-cache";
import type { BotGuild } from "../admin-discord-cache";
import type {
  AdminGuildDirectoryEntry,
  AdminGuildDirectoryResponse,
  AdminPermissionCheck,
  AdminPermissionCheckResponse,
  AdminPermissionDiagnosticsResponse,
  AdminPermissionFeature,
} from "../admin-types";
import { ALL_FEATURES_ENABLED, type FeatureFlags } from "../features";
import type { CustomerSession } from "../auth/customer-session";
import type { GuildDiscoveryService } from "../discord-guild-discovery";
import { getGuildEntitlementLimits } from "../../types";

const ADMIN_PERMISSION_FEATURES = [
  "blocklist",
  "timed-roles",
  "tickets",
  "marketplace",
  "lfg",
  "player-count",
  "wardogs",
  "server-levels",
  "steam-link",
  "evidence-vault",
  "mention-protection",
  "managed-messages",
  "member-verification",
  "image-rules",
  "bot-defense",
  "player-link",
  "events",
  "guild-audit-log",
  "webhooks",
  "ban-cases",
] as const;

const permissionsQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
});

const diagnosticsQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

export interface PermissionsAdminRoutesOptions {
  wardogs?: WardogsService;
  wardogsPlayerCountEnabled?: boolean;
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  discordBotToken: string;
  features?: FeatureFlags;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  listAuthorizedCustomerGuildIds?: (
    request: Request,
    botGuilds?: Promise<BotGuild[]>,
  ) => Promise<string[] | Response | null>;
  discordCache?: Cache<string>;
  discordSupportInvite?: string;
  guildDiscoveryService?: GuildDiscoveryService;
}

export function createPermissionsAdminRoutes(
  options: PermissionsAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  const features = options.features ?? ALL_FEATURES_ENABLED;

  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/permissions",
      query: permissionsQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query, url }) => {
        const { guildId, feature: featureParam } = query;
        if (!guildId || !featureParam) {
          return Response.json({ error: "guildId and feature are required" }, { status: 400 });
        }
        if (!isAdminPermissionFeature(featureParam)) {
          return Response.json(
            {
              error: `feature must be one of: ${ADMIN_PERMISSION_FEATURES.join(", ")}`,
            },
            { status: 400 },
          );
        }

        if (featureParam === "blocklist" && !features.blocklist) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "timed-roles" && !features.timedRoles) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "tickets" && !features.tickets) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "marketplace" && !features.marketplace) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "lfg" && !features.lfg) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "player-count" && !features.playerCount) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "steam-link" && !features.steamLink) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "evidence-vault" && !features.evidenceVault) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "mention-protection" && !features.mentionProtection) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "events" && !features.events) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "webhooks" && !features.webhookProxy) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (featureParam === "ban-cases" && !features.banCases) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        const refreshDiscordCache = shouldRefreshAdminDiscordCache(url);

        try {
          return Response.json(
            await buildAdminPermissionResponse(
              guildId,
              featureParam,
              options.stores,
              options.discordBotToken,
              refreshDiscordCache,
              options.wardogs,
            ),
          );
        } catch (error) {
          const rateLimitResponse = mapDiscordRateLimitError(error);
          if (rateLimitResponse) return rateLimitResponse;

          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to load the bot's current Discord permissions.",
            },
            { status: 502 },
          );
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/permissions/diagnostics",
      query: diagnosticsQuerySchema,
      access: ({ query }) => {
        const queryRecord = query as { guildId?: unknown; workspaceId?: unknown } | undefined;
        const guildId =
          typeof queryRecord?.guildId === "string" && queryRecord.guildId.length > 0
            ? queryRecord.guildId
            : null;
        if (!guildId) {
          return Response.json({ error: "guildId is required" }, { status: 400 });
        }
        const workspaceId =
          typeof queryRecord?.workspaceId === "string" && queryRecord.workspaceId.length > 0
            ? queryRecord.workspaceId
            : undefined;
        return workspaceId ? { mode: "read", guildId, workspaceId } : { mode: "read", guildId };
      },
      handler: async ({ query, url }) => {
        const { guildId } = query;
        if (!guildId) {
          return Response.json({ error: "guildId is required" }, { status: 400 });
        }
        const refreshDiscordCache = shouldRefreshAdminDiscordCache(url);
        try {
          return Response.json(
            await buildAdminPermissionDiagnosticsResponse(
              guildId,
              options.stores,
              options.discordBotToken,
              refreshDiscordCache,
              features,
              options.wardogs,
              options.wardogsPlayerCountEnabled,
            ),
          );
        } catch (error) {
          const rateLimitResponse = mapDiscordRateLimitError(error);
          if (rateLimitResponse) return rateLimitResponse;

          return Response.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to load the bot's current Discord permissions.",
            },
            { status: 502 },
          );
        }
      },
    }),
    defineRoute({
      ...bindAdminContract(getGuildDirectory),
      method: "GET",
      path: "/admin/api/guilds",
      access: { mode: "read", customerSessionOnly: true },
      handler: async ({ request, url }) => {
        const refreshDiscordCache = shouldRefreshAdminDiscordCache(url);
        try {
          const allGuildsPromise = getCachedBotGuilds(
            options.discordBotToken,
            refreshDiscordCache,
            options.discordCache,
          );
          const authorizedGuildIds = options.listAuthorizedCustomerGuildIds
            ? await options.listAuthorizedCustomerGuildIds(request, allGuildsPromise)
            : null;
          if (authorizedGuildIds instanceof Response) {
            return authorizedGuildIds;
          }
          const allGuilds = await allGuildsPromise;
          const guilds = buildAdminGuildDirectory(
            authorizedGuildIds
              ? filterGuildsByAuthorizedIds(allGuilds, authorizedGuildIds)
              : allGuilds,
          );
          const body: AdminGuildDirectoryResponse = { guilds };
          return Response.json(body);
        } catch (error) {
          const rateLimitResponse = mapDiscordRateLimitError(error);
          if (rateLimitResponse) return rateLimitResponse;

          return Response.json(
            {
              error:
                error instanceof Error ? error.message : "Failed to load the bot guild directory.",
            },
            { status: 502 },
          );
        }
      },
    }),
  ];
}

function isAdminPermissionFeature(value: string): value is AdminPermissionFeature {
  return (ADMIN_PERMISSION_FEATURES as readonly string[]).includes(value);
}

async function buildAdminPermissionResponse(
  guildId: string,
  feature: AdminPermissionFeature,
  stores: RuntimeStores,
  discordBotToken: string,
  refreshDiscordCache: boolean,
  wardogs?: WardogsService,
): Promise<AdminPermissionCheckResponse> {
  if (feature === "wardogs") {
    const targets = wardogs ? await wardogs.list(guildId) : [];
    return {
      guildId,
      feature,
      checks: wardogs
        ? [
            {
              id: "wardogs-read-approval",
              label: "WARDOGS read readiness",
              status:
                wardogs.setup().networkEnabled &&
                targets.some(
                  (target) =>
                    target.credentialConfigured &&
                    target.enabled &&
                    !target.stale &&
                    target.verifiedGeneration === target.generation,
                )
                  ? "ok"
                  : "warning",
              detail:
                "Read access requires an encrypted password, both network switches, operator approval of this generation and a successful read test. Writes remain unavailable.",
              remediation: "Open WARDOGS targets to configure or test read access.",
            },
          ]
        : [],
    };
  }

  const config = await stores.blocklist.readConfig();
  const context = await getCachedGuildPermissionContext(
    guildId,
    config.botUserId,
    discordBotToken,
    refreshDiscordCache,
  );
  const entitlement = await stores.guildEntitlements.readGuildEntitlement(guildId);
  const paidFeaturesAvailable = getGuildEntitlementLimits(entitlement.tier).paidFeatures;

  if (feature === "blocklist") {
    return {
      guildId,
      feature,
      checks: buildBlocklistPermissionChecks(context),
    };
  }

  if (feature === "timed-roles") {
    return {
      guildId,
      feature,
      checks: buildTimedRolePermissionChecks(
        context,
        await stores.timedRoles.listTimedRolesByGuild(guildId),
      ),
    };
  }

  if (feature === "marketplace") {
    return {
      guildId,
      feature,
      checks: buildMarketplacePermissionChecks(
        context,
        await stores.marketplace.readMarketplaceConfig(guildId),
      ),
    };
  }

  if (feature === "lfg") {
    return {
      guildId,
      feature,
      checks: buildLfgPermissionChecks(context, await stores.lfg.readLfgConfig(guildId)),
    };
  }

  if (feature === "player-count") {
    const servers = await stores.playerCount.listPlayerCountServers(guildId);
    return {
      guildId,
      feature,
      checks: buildPlayerCountPermissionChecks(
        context,
        servers.map((s) => s.channelId).filter((id): id is string => id !== null),
      ),
    };
  }

  if (feature === "server-levels") {
    const config = await stores.serverLevels?.readConfig(guildId);
    return {
      guildId,
      feature,
      checks: buildServerLevelsPermissionChecks(context, config?.announcementChannelId ?? null),
    };
  }

  if (feature === "steam-link") {
    return {
      guildId,
      feature,
      checks: buildSteamLinkPermissionChecks(
        context,
        await stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
      ),
    };
  }

  if (feature === "evidence-vault") {
    return {
      guildId,
      feature,
      checks: buildEvidenceVaultPermissionChecks(
        context,
        await stores.evidenceVault.readConfig(guildId),
      ),
    };
  }

  if (feature === "mention-protection") {
    const [config, auditConfig, entitlement] = await Promise.all([
      stores.mentionProtection.readConfig(guildId),
      stores.guildAuditLog.readConfig(guildId),
      stores.guildEntitlements.readGuildEntitlement(guildId),
    ]);
    return {
      guildId,
      feature,
      checks: buildMentionProtectionPermissionChecks(
        context,
        config,
        auditConfig,
        getGuildEntitlementLimits(entitlement.tier).paidFeatures,
      ),
    };
  }

  if (feature === "managed-messages") {
    const [messages, drafts] = await Promise.all([
      stores.managedMessages.listByGuild(guildId),
      stores.managedMessages.listDraftsByGuild(guildId),
    ]);
    return {
      guildId,
      feature,
      checks: buildManagedMessagePermissionChecks(context, messages, drafts),
    };
  }
  if (feature === "member-verification") {
    return {
      guildId,
      feature,
      checks: buildMemberVerificationPermissionChecks(
        context,
        await stores.memberVerification.readConfig(guildId),
      ),
    };
  }
  if (feature === "image-rules") {
    return {
      guildId,
      feature,
      checks: buildImageRulesPermissionChecks(context, await stores.imageRules.readConfig(guildId)),
    };
  }
  if (feature === "bot-defense") {
    return {
      guildId,
      feature,
      checks: buildBotDefensePermissionChecks(context, await stores.botDefense.readConfig(guildId)),
    };
  }
  if (feature === "player-link") {
    return {
      guildId,
      feature,
      checks: buildSteamLinkPermissionChecks(
        context,
        await stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
      ),
    };
  }

  if (feature === "events") {
    return {
      guildId,
      feature,
      checks: buildEventPermissionChecks(
        context,
        await stores.events.listEvents(guildId),
        paidFeaturesAvailable,
      ),
    };
  }

  if (feature === "guild-audit-log") {
    return {
      guildId,
      feature,
      checks: buildGuildAuditLogPermissionChecks(
        context,
        await stores.guildAuditLog.readConfig(guildId),
      ),
    };
  }

  if (feature === "webhooks") {
    return {
      guildId,
      feature,
      checks: buildWebhookPermissionChecks(
        await stores.webhookProxy.listWebhookProxyConfigs(guildId),
        paidFeaturesAvailable,
      ),
    };
  }

  if (feature === "ban-cases") {
    const [banCaseConfig, banCaseSources] = await Promise.all([
      stores.banCases.readConfig(guildId),
      stores.banCases.listBanCaseSources(guildId),
    ]);
    return {
      guildId,
      feature,
      checks: buildBanCasePermissionChecks(
        context,
        banCaseConfig,
        banCaseSources,
        paidFeaturesAvailable,
      ),
    };
  }

  return {
    guildId,
    feature,
    checks: buildTicketPermissionChecks(
      context,
      await stores.tickets.readTicketPanelConfig(guildId),
    ),
  };
}

async function buildAdminPermissionDiagnosticsResponse(
  guildId: string,
  stores: RuntimeStores,
  discordBotToken: string,
  refreshDiscordCache: boolean,
  features: FeatureFlags,
  wardogs?: WardogsService,
  wardogsPlayerCountEnabled = false,
): Promise<AdminPermissionDiagnosticsResponse> {
  const config = await stores.blocklist.readConfig();
  const context = await getCachedGuildPermissionContext(
    guildId,
    config.botUserId,
    discordBotToken,
    refreshDiscordCache,
  );

  const [
    timedRoles,
    ticketPanel,
    marketplaceConfig,
    lfgConfig,
    playerCountServers,
    serverLevelConfig,
    steamLinkConfig,
    evidenceVaultConfig,
    mentionProtectionConfig,
    guildAuditLogConfig,
    entitlement,
    managedMessages,
    managedMessageDrafts,
    memberVerificationConfig,
    imageRulesConfig,
    botDefenseConfig,
    events,
    webhookConfigs,
    banCaseConfig,
    banCaseSources,
  ] = await Promise.all([
    stores.timedRoles.listTimedRolesByGuild(guildId),
    stores.tickets.readTicketPanelConfig(guildId),
    stores.marketplace.readMarketplaceConfig(guildId),
    stores.lfg.readLfgConfig(guildId),
    stores.playerCount.listPlayerCountServers(guildId),
    stores.serverLevels?.readConfig(guildId) ?? Promise.resolve(null),
    stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
    stores.evidenceVault.readConfig(guildId),
    stores.mentionProtection.readConfig(guildId),
    stores.guildAuditLog.readConfig(guildId),
    stores.guildEntitlements.readGuildEntitlement(guildId),
    stores.managedMessages?.listByGuild(guildId) ?? Promise.resolve([]),
    stores.managedMessages?.listDraftsByGuild(guildId) ?? Promise.resolve([]),
    stores.memberVerification?.readConfig(guildId) ?? Promise.resolve(null),
    stores.imageRules?.readConfig(guildId) ?? Promise.resolve(null),
    stores.botDefense?.readConfig(guildId) ?? Promise.resolve(null),
    stores.events.listEvents(guildId),
    stores.webhookProxy.listWebhookProxyConfigs(guildId),
    stores.banCases.readConfig(guildId),
    stores.banCases.listBanCaseSources(guildId),
  ]);
  const paidFeaturesAvailable = getGuildEntitlementLimits(entitlement.tier).paidFeatures;

  return {
    guildId,
    checksByFeature: {
      wardogs: wardogs
        ? [
            {
              id: "wardogs-read-approval",
              label: "WARDOGS read readiness",
              status:
                wardogs.setup().networkEnabled &&
                (await wardogs.list(guildId)).some(
                  (target) =>
                    target.enabled &&
                    !target.stale &&
                    target.verifiedGeneration === target.generation,
                )
                  ? "ok"
                  : "warning",
              detail:
                "Read access requires an encrypted password, both network switches, operator approval of this generation and a successful read test. Writes remain unavailable.",
              remediation: "Open WARDOGS targets to configure or test read access.",
            },
          ]
        : [],
      blocklist: features.blocklist ? buildBlocklistPermissionChecks(context) : [],
      "timed-roles": features.timedRoles ? buildTimedRolePermissionChecks(context, timedRoles) : [],
      tickets: features.tickets ? buildTicketPermissionChecks(context, ticketPanel) : [],
      marketplace: features.marketplace
        ? buildMarketplacePermissionChecks(context, marketplaceConfig)
        : [],
      lfg: features.lfg ? buildLfgPermissionChecks(context, lfgConfig) : [],
      "player-count": features.playerCount
        ? [
            ...buildPlayerCountPermissionChecks(
              context,
              playerCountServers
                .map((server) => server.channelId)
                .filter((id): id is string => id !== null),
            ),
            ...(await Promise.all(
              playerCountServers
                .filter((server) => server.provider === "wardogs-rcon")
                .map(async (server): Promise<AdminPermissionCheck> => {
                  const state = await wardogs?.statusReadiness(guildId, server.providerServerId);
                  const ready = wardogsPlayerCountEnabled && state?.ready;
                  return {
                    id: `player-count-wardogs-${server.id}`,
                    label: `${server.name}: WARDOGS read access`,
                    status: ready ? "ok" : "warning",
                    detail: !wardogsPlayerCountEnabled
                      ? "WARDOGS Player Count is disabled by the HAF operator."
                      : (state?.error ??
                        (ready
                          ? "Current target configuration has verified read approval."
                          : "WARDOGS target is unavailable for this Guild.")),
                    remediation: ready
                      ? undefined
                      : "Configure and verify the secure WARDOGS target before polling.",
                  };
                }),
            )),
          ]
        : [],
      "server-levels": features.serverLevels
        ? buildServerLevelsPermissionChecks(
            context,
            serverLevelConfig?.announcementChannelId ?? null,
          )
        : [],
      "steam-link": features.steamLink
        ? buildSteamLinkPermissionChecks(context, steamLinkConfig)
        : [],
      "evidence-vault": features.evidenceVault
        ? buildEvidenceVaultPermissionChecks(context, evidenceVaultConfig)
        : [],
      "mention-protection": features.mentionProtection
        ? buildMentionProtectionPermissionChecks(
            context,
            mentionProtectionConfig,
            guildAuditLogConfig,
            getGuildEntitlementLimits(entitlement.tier).paidFeatures,
          )
        : [],
      "managed-messages": buildManagedMessagePermissionChecks(
        context,
        managedMessages,
        managedMessageDrafts,
      ),
      "member-verification": features.memberVerification
        ? buildMemberVerificationPermissionChecks(context, memberVerificationConfig)
        : [],
      "image-rules": features.imageRules
        ? buildImageRulesPermissionChecks(context, imageRulesConfig)
        : [],
      "bot-defense": features.botDefense
        ? buildBotDefensePermissionChecks(context, botDefenseConfig)
        : [],
      "player-link": features.steamLink
        ? buildSteamLinkPermissionChecks(context, steamLinkConfig)
        : [],
      events: features.events
        ? buildEventPermissionChecks(context, events, paidFeaturesAvailable)
        : [],
      "guild-audit-log": buildGuildAuditLogPermissionChecks(context, guildAuditLogConfig),
      webhooks: features.webhookProxy
        ? buildWebhookPermissionChecks(webhookConfigs, paidFeaturesAvailable)
        : [],
      "ban-cases": features.banCases
        ? buildBanCasePermissionChecks(
            context,
            banCaseConfig,
            banCaseSources,
            paidFeaturesAvailable,
          )
        : [],
    },
  };
}

function buildAdminGuildDirectory(
  guilds: Array<{ guildId: string; name: string; icon: string | null }>,
): AdminGuildDirectoryEntry[] {
  const nameCounts = new Map<string, number>();

  for (const guild of guilds) {
    nameCounts.set(guild.name, (nameCounts.get(guild.name) ?? 0) + 1);
  }

  return [...guilds]
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.guildId.localeCompare(right.guildId),
    )
    .map((guild) => ({
      guildId: guild.guildId,
      name: guild.name,
      label:
        (nameCounts.get(guild.name) ?? 0) > 1 ? `${guild.name} (${guild.guildId})` : guild.name,
      icon: typeof guild.icon === "string" && guild.icon ? guild.icon : null,
    }));
}

function filterGuildsByAuthorizedIds(
  guilds: Array<{ guildId: string; name: string; icon: string | null }>,
  authorizedGuildIds: string[],
): Array<{ guildId: string; name: string; icon: string | null }> {
  const authorized = new Set(authorizedGuildIds);
  return guilds.filter((guild) => authorized.has(guild.guildId));
}

function mapDiscordRateLimitError(error: unknown): Response | null {
  if (!(error instanceof DiscordApiError) || error.status !== 429) {
    return null;
  }

  const body: { error: string; code: string; retryAfterSeconds?: number } = {
    error: "Discord is rate limiting server discovery. Try again shortly.",
    code: "discord_rate_limited",
  };
  if (error.retryAfterMs !== undefined) {
    body.retryAfterSeconds = Math.ceil(error.retryAfterMs / 1000);
  }
  return Response.json(body, { status: 429 });
}
