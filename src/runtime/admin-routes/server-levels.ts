import { z } from "zod";
import {
  SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS,
  type ConfiguredGameServer,
} from "../../server-levels/model";
import type { ServerLevelCredentialService } from "../../server-levels/credentials";
import type { ServerLevelProcessor } from "../../server-levels/processor";
import type { AuditEventId } from "../../types";
import { postMemberAuditEvent } from "../../services/guild-audit-log-service";
import type { GuildResourceValidator } from "../../discord/guild-resource-validator";
import {
  DISCORD_PERMISSION_FLAGS,
  getChannelPermissions,
  hasPermission,
  loadGuildPermissionContext,
  type GuildPermissionContext,
} from "../admin-permissions";
import type { RuntimeStores } from "../app-types";
import type { CustomerSession } from "../auth/customer-session";
import { defineRoute, type Route } from "../admin-route-registry";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";

const guildQuery = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});
const guildBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});
const configBody = guildBody.extend({
  enabled: z.boolean(),
  announcementChannelId: z.string().min(1).max(100).nullable().optional(),
});
const serverBody = guildBody.extend({
  displayName: z.string().trim().min(1).max(100),
  providerServerId: z.string().trim().min(1).max(200),
  maxSlots: z.number().int().min(1).max(10_000),
});
const providerSecretBody = guildBody.extend({
  secret: z.string().min(8).max(500),
});
const dataApiCredentialBody = guildBody.extend({
  applicationId: z.string().trim().min(1).max(200),
  secret: z.string().min(8).max(500),
});
const removeBody = guildBody.extend({ confirmation: z.literal("REMOVE") });
const subscriptionConfirmationBody = guildBody.extend({
  confirmation: z.literal("SUBSCRIPTIONS_CONFIGURED"),
});

export interface ServerLevelsAdminRouteOptions {
  stores: RuntimeStores;
  credentials?: ServerLevelCredentialService;
  processingAvailable?: boolean;
  processor?: ServerLevelProcessor;
  now?: () => number;
  publicBaseUrl?: string;
  discordBotToken: string;
  discordBotUserId?: string;
  guildResources: GuildResourceValidator;
  loadPermissionContext?: (
    guildId: string,
    botUserId: string,
    botToken: string,
  ) => Promise<GuildPermissionContext>;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}

export function createServerLevelsAdminRoutes(
  options: ServerLevelsAdminRouteOptions,
): Array<Route<any, any, Response>> {
  const store = options.stores.serverLevels;
  if (!store) return [];
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/server-levels",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      query: guildQuery,
      access: guildScopedAccess("read"),
      handler: async ({ query, request }) => {
        const guildId = requireGuildQueryId(query);
        const [config, servers, steamLinkConfig] = await Promise.all([
          store.readConfig(guildId),
          store.listConfiguredGameServers(guildId),
          options.stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
        ]);
        return Response.json({
          config,
          servers: await Promise.all(
            servers.map((server) => publicServer(options, server, baseUrl(options, request))),
          ),
          beta: true,
          maxServers: 5,
          requiredEvents: SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS,
          steamLinkConfigured: steamLinkConfig !== null,
          credentialEncryptionAvailable: Boolean(options.credentials),
          processingAvailable: options.processingAvailable ?? false,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/server-levels/config",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: configBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (body.announcementChannelId) {
          await options.guildResources.requireTextChannel(body.guildId, body.announcementChannelId);
          if (!options.discordBotUserId) {
            return Response.json(
              { error: "Bot permission verification is unavailable." },
              { status: 503 },
            );
          }
          let permissionContext: GuildPermissionContext;
          try {
            permissionContext = await (options.loadPermissionContext ?? loadGuildPermissionContext)(
              body.guildId,
              options.discordBotUserId,
              options.discordBotToken,
            );
          } catch {
            return Response.json(
              { error: "Bot permission verification is unavailable." },
              { status: 503 },
            );
          }
          const channel = permissionContext.channels.find(
            (entry) => entry.id === body.announcementChannelId,
          );
          const permissions = channel ? getChannelPermissions(permissionContext, channel) : 0n;
          if (
            !channel ||
            !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel) ||
            !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.sendMessages)
          ) {
            return Response.json(
              { error: "HAF Bot needs View Channel and Send Messages in that channel." },
              { status: 409 },
            );
          }
        }
        const now = options.now?.() ?? Date.now();
        const current = await store.readConfig(body.guildId);
        if (current?.enabled === true && !body.enabled) {
          if (!options.processor) return unavailableProcessing();
          await options.processor.stopEarningForGuild({
            guildId: body.guildId,
            stoppedAtMs: now,
            reason: "feature_disabled",
            sourceId: `server-level-disable:${body.guildId}:${current.updatedAtMs}`,
          });
        }
        await store.upsertConfig({
          guildId: body.guildId,
          enabled: body.enabled,
          announcementChannelId:
            body.announcementChannelId === undefined
              ? (current?.announcementChannelId ?? null)
              : body.announcementChannelId,
          removedAtMs: null,
          updatedAtMs: now,
        });
        await auditServerLevelChange(
          options,
          current?.enabled === body.enabled
            ? "server-level.config-change"
            : body.enabled
              ? "server-level.enable"
              : "server-level.disable",
          body.guildId,
          request,
          { Enabled: body.enabled },
        );
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/server-levels/servers",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: serverBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.credentials) return unavailableCredentials();
        const config = await store.readConfig(body.guildId);
        if (!config?.enabled || config.removedAtMs !== null) {
          return Response.json(
            { error: "Enable Server Levels before adding a server." },
            { status: 409 },
          );
        }
        const now = Date.now();
        const serverId = crypto.randomUUID();
        const endpointId = crypto.randomUUID();
        const rotated = await options.credentials.rotateWebhookSecret({
          guildId: body.guildId,
          configuredGameServerId: serverId,
          nowMs: now,
        });
        try {
          await store.createConfiguredGameServer({
            id: serverId,
            guildId: body.guildId,
            displayName: body.displayName,
            providerServerId: body.providerServerId,
            maxSlots: body.maxSlots,
            endpointId,
            webhookCredentialId: rotated.credentialId,
            webhookVerifiedAtMs: null,
            subscribedEvents: [],
            capacityProposal: null,
            lastRosterReconciledAtMs: null,
            lastCapacityCheckedAtMs: null,
            createdAtMs: now,
            updatedAtMs: now,
          });
        } catch (error) {
          await options.credentials.deleteCredential({
            credentialId: rotated.credentialId,
            configuredGameServerId: serverId,
          });
          throw error;
        }
        const server = await store.readConfiguredGameServer(body.guildId, serverId);
        await auditServerLevelChange(options, "server-level.server-add", body.guildId, request, {
          Server: body.displayName,
          "Maximum slots": body.maxSlots,
        });
        return Response.json(
          {
            ok: true,
            server: server ? await publicServer(options, server, baseUrl(options, request)) : null,
            setup: secretSetup(endpointId, baseUrl(options, request)),
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/server-levels/servers/:serverId/subscriptions",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: subscriptionConfirmationBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        const server = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!server) return Response.json({ error: "Not found" }, { status: 404 });
        await store.updateConfiguredGameServer({
          ...server,
          subscribedEvents: [...SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS],
          updatedAtMs: Date.now(),
        });
        await auditServerLevelChange(options, "server-level.config-change", body.guildId, request, {
          Server: server.displayName,
          "Webhook subscriptions": "Confirmed",
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "PATCH",
      path: "/admin/api/server-levels/servers/:serverId",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: serverBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        const current = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!current) return Response.json({ error: "Not found" }, { status: 404 });
        const now = options.now?.() ?? Date.now();
        const replacement: ConfiguredGameServer = {
          ...current,
          displayName: body.displayName,
          providerServerId: body.providerServerId,
          maxSlots: body.maxSlots,
          webhookVerifiedAtMs:
            current.providerServerId === body.providerServerId ? current.webhookVerifiedAtMs : null,
          subscribedEvents:
            current.providerServerId === body.providerServerId ? current.subscribedEvents : [],
          capacityProposal:
            current.providerServerId !== body.providerServerId ||
            current.capacityProposal?.maxSlots === body.maxSlots
              ? null
              : current.capacityProposal,
          lastRosterReconciledAtMs:
            current.providerServerId === body.providerServerId
              ? current.lastRosterReconciledAtMs
              : null,
          lastCapacityCheckedAtMs:
            current.providerServerId === body.providerServerId
              ? current.lastCapacityCheckedAtMs
              : null,
          updatedAtMs: now,
        };
        if (current.providerServerId === body.providerServerId) {
          await store.updateConfiguredGameServer(replacement);
        } else {
          if (!options.processor) return unavailableProcessing();
          await options.processor.replaceConfiguredGameServerProvider({
            current,
            replacement,
            changedAtMs: now,
            sourceId: `server-level-provider-change:${current.id}:${current.updatedAtMs}`,
          });
        }
        await auditServerLevelChange(
          options,
          current.maxSlots !== body.maxSlots && current.capacityProposal?.maxSlots === body.maxSlots
            ? "server-level.capacity-accept"
            : "server-level.config-change",
          body.guildId,
          request,
          { Server: body.displayName, "Maximum slots": body.maxSlots },
        );
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/server-levels/servers/:serverId/rotate-secret",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: providerSecretBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        if (!options.credentials) return unavailableCredentials();
        const server = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!server) return Response.json({ error: "Not found" }, { status: 404 });
        const rotated = await options.credentials.storeWebhookSecret({
          guildId: body.guildId,
          configuredGameServerId: server.id,
          secret: body.secret,
        });
        await store.updateConfiguredGameServer({
          ...server,
          webhookCredentialId: rotated.credentialId,
          webhookVerifiedAtMs: null,
          updatedAtMs: Date.now(),
        });
        await auditServerLevelChange(
          options,
          "server-level.credential-rotate",
          body.guildId,
          request,
          { Server: server.displayName },
        );
        return Response.json(
          {
            ok: true,
            setup: secretSetup(server.endpointId, baseUrl(options, request)),
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/server-levels/servers/:serverId/data-api",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: dataApiCredentialBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        if (!options.credentials) return unavailableCredentials();
        const server = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!server) return Response.json({ error: "Not found" }, { status: 404 });
        await options.credentials.storeDataApiCredentials({
          guildId: body.guildId,
          configuredGameServerId: server.id,
          applicationId: body.applicationId,
          secret: body.secret,
        });
        await store.updateConfiguredGameServer({
          ...server,
          lastRosterReconciledAtMs: null,
          lastCapacityCheckedAtMs: null,
          capacityProposal: null,
          updatedAtMs: Date.now(),
        });
        await auditServerLevelChange(
          options,
          "server-level.credential-rotate",
          body.guildId,
          request,
          { Server: server.displayName, Credential: "CFTools Data API" },
        );
        return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/admin/api/server-levels/servers/:serverId/data-api",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: guildBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        if (!options.credentials) return unavailableCredentials();
        const server = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!server) return Response.json({ error: "Not found" }, { status: 404 });
        await options.credentials.deleteDataApiCredential({
          guildId: body.guildId,
          configuredGameServerId: server.id,
        });
        await auditServerLevelChange(
          options,
          "server-level.credential-rotate",
          body.guildId,
          request,
          { Server: server.displayName, Credential: "CFTools Data API removed" },
        );
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/admin/api/server-levels/servers/:serverId",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: guildBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, params, request }) => {
        const server = await store.readConfiguredGameServer(body.guildId, params.serverId ?? "");
        if (!server) return Response.json({ error: "Not found" }, { status: 404 });
        const now = Date.now();
        await store.closeAllEarningSessions(server.id, now, "configured_server_removed");
        await store.clearCurrentPresence(body.guildId, server.id);
        await store.deleteConfiguredGameServer(body.guildId, server.id);
        await auditServerLevelChange(options, "server-level.server-remove", body.guildId, request, {
          Server: server.displayName,
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/admin/api/server-levels",
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      body: removeBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const now = Date.now();
        const servers = await store.listConfiguredGameServers(body.guildId);
        for (const server of servers) {
          await store.closeAllEarningSessions(server.id, now, "system_removed");
          await store.clearCurrentPresence(body.guildId, server.id);
        }
        await store.upsertConfig({
          guildId: body.guildId,
          enabled: false,
          announcementChannelId: null,
          removedAtMs: now,
          updatedAtMs: now,
        });
        await auditServerLevelChange(options, "server-level.config-change", body.guildId, request, {
          Action: "Removed Server Levels",
        });
        return Response.json({ ok: true });
      },
    }),
  ];
}

async function auditServerLevelChange(
  options: ServerLevelsAdminRouteOptions,
  eventId: AuditEventId,
  guildId: string,
  request: Request,
  context: Record<string, unknown>,
): Promise<void> {
  const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
  await postMemberAuditEvent(
    eventId,
    { guildId, ...(actorUserId ? { user: { id: actorUserId } } : {}), context },
    options.stores.guildAuditLog,
    options.discordBotToken,
  );
}

function baseUrl(options: ServerLevelsAdminRouteOptions, request: Request): string {
  return (options.publicBaseUrl ?? new URL(request.url).origin).replace(/\/$/, "");
}

async function publicServer(
  options: ServerLevelsAdminRouteOptions,
  server: ConfiguredGameServer,
  publicBaseUrl: string,
) {
  return {
    id: server.id,
    displayName: server.displayName,
    providerServerId: server.providerServerId,
    maxSlots: server.maxSlots,
    webhookUrl: `${publicBaseUrl}/webhooks/server-levels/cftools/${encodeURIComponent(server.endpointId)}`,
    webhookVerifiedAtMs: server.webhookVerifiedAtMs,
    subscribedEvents: server.subscribedEvents,
    capacityProposal: server.capacityProposal,
    dataApiConfigured:
      (await options.credentials?.hasDataApiCredential({
        guildId: server.guildId,
        configuredGameServerId: server.id,
      })) ?? false,
    lastRosterReconciledAtMs: server.lastRosterReconciledAtMs,
    lastCapacityCheckedAtMs: server.lastCapacityCheckedAtMs,
    createdAtMs: server.createdAtMs,
    updatedAtMs: server.updatedAtMs,
  };
}

function secretSetup(endpointId: string, publicBaseUrl: string) {
  return {
    webhookUrl: `${publicBaseUrl}/webhooks/server-levels/cftools/${encodeURIComponent(endpointId)}`,
    requiredEvents: SERVER_LEVEL_REQUIRED_WEBHOOK_EVENTS,
    payloadFormat: "CFTools Cloud (Hephaistos v1)",
  };
}

function unavailableCredentials(): Response {
  return Response.json(
    { error: "Server Levels credential encryption is unavailable." },
    { status: 503 },
  );
}

function unavailableProcessing(): Response {
  return Response.json({ error: "Server Levels processing is unavailable." }, { status: 503 });
}
