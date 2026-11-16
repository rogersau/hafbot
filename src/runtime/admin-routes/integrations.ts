import type { WardogsService } from "../../wardogs/service";
import { defineRoute, type Route } from "../admin-route-registry";
import type { AdminAccess } from "../admin-access";
import type { RuntimeStores } from "../app-types";
import type { PlayerCountServer } from "../../types/player-count";
import type { WebhookProxyConfig } from "../../types";
import { z } from "zod";
import { DiscordApiError, createChannelMessage, editChannelMessage } from "../../discord";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import { DISCORD_BUTTON_COMPONENT, DISCORD_MESSAGE_COMPONENT_ROW } from "../../discord/constants";
import {
  guildScopedAccess,
  bodyGuildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import type { ServiceFactory } from "../service-factory";
import type { WebhookCredentialService } from "../../security/webhook-credentials/store";
import type { WebhookIngressGuardNamespace } from "../contracts/webhook-ingress-guard";
import type { CustomerSession } from "../auth/customer-session";
import {
  postPlatformLinkPanelPublishFailedAuditEvent,
  postWebhookCredentialRevealAuditEvent,
} from "../../services/guild-audit-log-service";
import type { ConfigurationActorContext } from "../../configuration-revisions";
import { webhookProxyRevisionAdapter } from "../../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../../configuration-revisions/coordinator";
import {
  adminErrorEnvelopeSchema,
  deleteWebhookProxy,
  getWebhookProxy,
  getWebhookProxyIngressHealth,
  listWebhookProxyLogs,
  revealWebhookProxyBanCredential,
  revealWebhookProxyCredential,
  saveWebhookProxy,
  deletePlayerCountServer,
  getPlayerCount,
  savePlayerCountServer,
  setPlayerCountEnabled,
  setPlayerLinkEnabled,
  testPlayerCount,
  getPlayerLink,
  publishPlayerLink as publishPlayerLinkOperation,
  savePlayerLink as savePlayerLinkOperation,
  syncPlayerLinkRoles as syncPlayerLinkRolesOperation,
  webhookProxyConfigBodySchema,
} from "../../contracts/admin";

const playerLinkConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  platform: z.enum(["steam", "xbox", "playstation"]),
  linkedRoleId: z.string().nullable().optional(),
  logChannelId: z.string().nullable().optional(),
  gameAppIds: z.array(z.string().regex(/^\d+$/, "Invalid gameAppIds entry")).optional(),
  panelTitle: z
    .string()
    .min(1, "Missing panelTitle")
    .transform((value) => value.trim()),
  panelDescription: z
    .string()
    .min(1, "Missing panelDescription")
    .transform((value) => value.trim()),
  panelButtonLabel: z
    .string()
    .min(1, "Missing panelButtonLabel")
    .transform((value) => value.trim()),
  panelButtonStyle: z.enum(["Primary", "Secondary", "Success", "Danger"], {
    error: () => "Invalid panelButtonStyle. Use Primary, Secondary, Success, or Danger",
  }),
  panelColor: z.number().int().min(0).max(0xffffff).optional(),
  allowRelink: z.boolean({ error: () => "Missing allowRelink" }),
  allowMultipleLinks: z.boolean({ error: () => "Missing allowMultipleLinks" }).optional(),
  requireRelinkOnRejoin: z.boolean().optional(),
  whoisFields: z.array(z.string().min(1)).optional(),
  customLinks: z
    .array(
      z.object({
        label: z.string().transform((value) => value.trim()),
        url: z.string().transform((value) => value.trim()),
      }),
    )
    .optional(),
});

const playerLinkPublishBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  platform: z.enum(["steam", "xbox", "playstation"]),
  panelChannelId: z.string().min(1, "Missing panelChannelId"),
});

const playerLinkSyncRolesBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  platform: z.enum(["steam", "xbox", "playstation"]),
});

export interface IntegrationsAdminRoutesOptions {
  wardogs?: WardogsService;
  wardogsPlayerCountEnabled?: boolean;
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  discordBotToken: string;
  invalidateWebhookProxyConfig?: (publicId: string) => void;
  services: Pick<
    ServiceFactory,
    "platformLinkService" | "playerCountService" | "operationalIncidentService"
  >;
  webhookCredentialService?: WebhookCredentialService;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  guildResources?: GuildResourceValidator;
}

type PlayerLinkConfigBody = z.infer<typeof playerLinkConfigBodySchema>;
type PlayerLinkPublishBody = z.infer<typeof playerLinkPublishBodySchema>;
type PlayerLinkSyncRolesBody = z.infer<typeof playerLinkSyncRolesBodySchema>;

function resolveGuildResources(options: IntegrationsAdminRoutesOptions): GuildResourceValidator {
  return options.guildResources ?? createDiscordGuildResourceValidator(options.discordBotToken);
}

async function savePlayerLinkConfig(
  options: IntegrationsAdminRoutesOptions,
  body: PlayerLinkConfigBody,
): Promise<Response> {
  const resources = await resolveGuildResources(options).forGuild(body.guildId);
  if (body.linkedRoleId) resources.requireRole(body.linkedRoleId);
  if (body.logChannelId) resources.requireTextChannel(body.logChannelId);
  const existing = await options.stores.platformLink.readPlatformLinkConfig(
    body.guildId,
    body.platform,
  );
  const customLinks = body.customLinks ?? [];
  const whoisFields = body.whoisFields ?? [];
  const filteredCustomLinks =
    body.platform === "steam"
      ? customLinks.filter((entry) => entry.label.length > 0 && entry.url.length > 0)
      : [];
  let gameAppIds: number[] = [];
  if (body.platform === "steam") {
    try {
      gameAppIds = parseSteamGameAppIds(body.gameAppIds ?? []);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid gameAppIds" },
        { status: 400 },
      );
    }
  }

  await options.stores.platformLink.upsertPlatformLinkConfig({
    guildId: body.guildId,
    platform: body.platform,
    ...(existing?.enabled === false ? { enabled: false } : {}),
    linkedRoleId: body.linkedRoleId ?? null,
    logChannelId: body.logChannelId ?? null,
    gameAppIds,
    panelTitle: body.panelTitle,
    panelDescription: body.panelDescription,
    panelButtonLabel: body.panelButtonLabel,
    panelButtonStyle: body.panelButtonStyle,
    panelColor:
      body.panelColor ??
      existing?.panelColor ??
      (body.platform === "xbox" ? 0x107c10 : body.platform === "playstation" ? 0x003791 : 0x5865f2),
    allowRelink: body.allowRelink,
    allowMultipleLinks: body.allowMultipleLinks ?? false,
    requireRelinkOnRejoin: body.requireRelinkOnRejoin ?? existing?.requireRelinkOnRejoin ?? false,
    whoisFields: whoisFields.filter((field) => field.length > 0),
    customLinks: filteredCustomLinks,
    panelChannelId: existing?.panelChannelId ?? null,
    panelMessageId: existing?.panelMessageId ?? null,
    updatedAtMs: Date.now(),
  });
  return Response.json({ ok: true });
}

async function publishPlayerLinkPanel(
  options: IntegrationsAdminRoutesOptions,
  body: PlayerLinkPublishBody,
): Promise<Response> {
  const config = await options.stores.platformLink.readPlatformLinkConfig(
    body.guildId,
    body.platform,
  );
  if (!config) return Response.json({ error: "Not found" }, { status: 404 });
  const resources = await resolveGuildResources(options).forGuild(body.guildId);
  resources.requireTextChannel(body.panelChannelId);
  if (config.linkedRoleId) resources.requireRole(config.linkedRoleId);
  if (config.logChannelId) resources.requireTextChannel(config.logChannelId);

  const buttonStyleMap: Record<string, number> = {
    Primary: 1,
    Secondary: 2,
    Success: 3,
    Danger: 4,
  };
  const messageContent = {
    embeds: [
      {
        title: config.panelTitle,
        description: config.panelDescription,
        color:
          config.panelColor ??
          (body.platform === "playstation"
            ? 0x003791
            : body.platform === "xbox"
              ? 0x107c10
              : 0x5865f2),
      },
    ],
    components: [
      {
        type: DISCORD_MESSAGE_COMPONENT_ROW,
        components: [
          {
            type: DISCORD_BUTTON_COMPONENT,
            custom_id: `${body.platform}_link_button`,
            label: config.panelButtonLabel,
            style: buttonStyleMap[config.panelButtonStyle] ?? 1,
          },
        ],
      },
    ],
  };

  let panelMessageId: string | undefined;
  try {
    if (config.panelMessageId) {
      try {
        const updated = await editChannelMessage(
          body.panelChannelId,
          config.panelMessageId,
          messageContent,
          options.discordBotToken,
        );
        panelMessageId = updated.id;
      } catch (error) {
        if (!(error instanceof DiscordApiError) || error.status !== 404) throw error;
      }
    }
    if (!panelMessageId) {
      const created = await createChannelMessage(
        body.panelChannelId,
        messageContent,
        options.discordBotToken,
      );
      panelMessageId = created.id;
    }

    await options.stores.platformLink.upsertPlatformLinkConfig({
      ...config,
      panelChannelId: body.panelChannelId,
      panelMessageId,
      updatedAtMs: Date.now(),
    });
    await observePlayerLinkPanelPublishHealthy(options, body);
    return Response.json({ ok: true, panelMessageId });
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 403) {
      await reportPlayerLinkPanelPublishPermissionDenied(options, body);
    }
    throw error;
  }
}

async function reportPlayerLinkPanelPublishPermissionDenied(
  options: IntegrationsAdminRoutesOptions,
  body: PlayerLinkPublishBody,
): Promise<void> {
  try {
    await Promise.all([
      postPlatformLinkPanelPublishFailedAuditEvent(
        {
          guildId: body.guildId,
          platform: body.platform,
          panelChannelId: body.panelChannelId,
        },
        options.stores.guildAuditLog,
        options.discordBotToken,
      ),
      options.services.operationalIncidentService.observeFailure({
        guildId: body.guildId,
        key: {
          feature: "platform-link",
          resourceKind: "platform",
          resourceId: body.platform,
          condition: "panel-publish-permission-denied",
        },
        summaryCode: "platform_link_panel_publish_permission_denied",
        safeArgs: { platform: body.platform, panelChannelId: body.panelChannelId },
        remediationCode: "operator_intervention_required",
      }),
    ]);
  } catch (error) {
    console.error("Failed to record Player Link panel publication permission failure", error);
  }
}

async function observePlayerLinkPanelPublishHealthy(
  options: IntegrationsAdminRoutesOptions,
  body: PlayerLinkPublishBody,
): Promise<void> {
  try {
    await options.services.operationalIncidentService.observeHealthy({
      guildId: body.guildId,
      key: {
        feature: "platform-link",
        resourceKind: "platform",
        resourceId: body.platform,
        condition: "panel-publish-permission-denied",
      },
    });
  } catch (error) {
    console.error("Failed to resolve Player Link panel publication permission incident", error);
  }
}

async function syncPlayerLinkRoles(
  options: IntegrationsAdminRoutesOptions,
  body: PlayerLinkSyncRolesBody,
): Promise<Response> {
  const platformLinkService = options.services.platformLinkService;
  const result = await platformLinkService.syncLinkedRoles(body.guildId, body.platform);
  return Response.json({ ok: true, ...result });
}

const REVEAL_RESPONSE_HEADERS = {
  "cache-control": "no-store, private, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

async function adminWebhookProxyConfig(
  service: WebhookCredentialService,
  config: WebhookProxyConfig,
) {
  const destinations = await Promise.all(
    config.destinations.map(async (destination) => ({
      id: destination.id,
      label: destination.label,
      credential: await service.masked(destination.credentialId, {
        kind: "proxy_destination",
        guildId: config.guildId,
        publicId: config.publicId,
        destinationId: destination.id,
      }),
    })),
  );
  const banLookupCredential = config.banLookupCredentialId
    ? await service.masked(config.banLookupCredentialId, {
        kind: "ban_lookup_notification",
        guildId: config.guildId,
        publicId: config.publicId,
      })
    : null;
  return {
    guildId: config.guildId,
    publicId: config.publicId,
    name: config.name,
    enabled: config.enabled,
    banLookupEnabled: config.banLookupEnabled,
    banLookupCredential,
    banLookupAppIds: config.banLookupAppIds,
    destinations,
    defaultDestinationIds: config.defaultDestinationIds,
    routingRules: config.routingRules,
    contentReplacements: config.contentReplacements ?? [],
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

async function saveWebhookProxyConfig(
  options: IntegrationsAdminRoutesOptions,
  body: z.infer<typeof webhookProxyConfigBodySchema>,
  actor: ConfigurationActorContext,
): Promise<Response> {
  const credentials = options.webhookCredentialService;
  if (!credentials) {
    return Response.json({ error: "Webhook credential service is unavailable" }, { status: 503 });
  }
  const now = Date.now();
  const publicId = body.publicId ?? createWebhookProxyPublicId();
  const existing = body.publicId
    ? await options.stores.webhookProxy.readWebhookProxyConfig(body.publicId)
    : null;
  if (existing && existing.guildId !== body.guildId) {
    return Response.json({ error: "Webhook URL belongs to another guild." }, { status: 409 });
  }

  const destinations = [];
  for (const destination of body.destinations) {
    const owner = {
      kind: "proxy_destination" as const,
      guildId: body.guildId,
      publicId,
      destinationId: destination.id,
    };
    const masked =
      destination.credential.action === "replace"
        ? await credentials.replace(owner, destination.credential.url)
        : await credentials.preserve(destination.credential.credentialId, owner);
    destinations.push({
      id: destination.id,
      label: destination.label,
      credentialId: masked.credentialId,
    });
  }

  const banOwner = {
    kind: "ban_lookup_notification" as const,
    guildId: body.guildId,
    publicId,
  };
  let banLookupCredentialId: string | null = null;
  if (body.banLookupCredential.action !== "clear") {
    const masked =
      body.banLookupCredential.action === "replace"
        ? await credentials.replace(banOwner, body.banLookupCredential.url)
        : await credentials.preserve(body.banLookupCredential.credentialId, banOwner);
    banLookupCredentialId = masked.credentialId;
  }

  const config: WebhookProxyConfig = {
    guildId: body.guildId,
    publicId,
    name: body.name,
    enabled: body.enabled,
    banLookupEnabled: body.banLookupEnabled,
    banLookupCredentialId,
    banLookupAppIds: body.banLookupAppIds,
    destinations,
    defaultDestinationIds: body.defaultDestinationIds,
    routingRules: body.routingRules.map((rule) => ({ ...rule, flags: rule.flags ?? "" })),
    contentReplacements: (body.contentReplacements ?? []).map((entry) => ({
      ...entry,
      flags: entry.flags ?? "",
    })),
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  };
  await commitVersionedConfigurationMutation({
    revisions: options.stores.configurationRevisions,
    entitlements: options.stores.guildEntitlements,
    mutation: {
      guildId: body.guildId,
      feature: "webhook-proxy",
      resourceKey: publicId,
      current: existing,
      next: config,
      adapter: webhookProxyRevisionAdapter,
      actor,
    },
    commitFree: () => options.stores.webhookProxy.upsertWebhookProxyConfig(config),
  });

  const retainedIds = new Set(destinations.map((destination) => destination.credentialId));
  for (const old of existing?.destinations ?? []) {
    if (!retainedIds.has(old.credentialId)) {
      await credentials.remove(old.credentialId, {
        kind: "proxy_destination",
        guildId: body.guildId,
        publicId,
        destinationId: old.id,
      });
    }
  }
  if (existing?.banLookupCredentialId && existing.banLookupCredentialId !== banLookupCredentialId) {
    await credentials.remove(existing.banLookupCredentialId, banOwner);
  }

  options.invalidateWebhookProxyConfig?.(publicId);
  return Response.json({ ok: true, publicId });
}

export function createIntegrationsAdminRoutes(
  options: IntegrationsAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...setPlayerCountEnabled,
      method: "POST",
      path: "/admin/api/player-count/enabled",
      body: setPlayerCountEnabled.body,
      success: setPlayerCountEnabled.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "playerCount",
      handler: async ({ body }) => {
        const config = await options.stores.playerCount.readPlayerCountServer(body.id);
        if (!config || config.guildId !== body.guildId)
          return Response.json({ error: "Configuration not found." }, { status: 404 });
        if (
          !(await options.stores.playerCount.setPlayerCountServerEnabled(
            body.guildId,
            body.id,
            body.enabled,
          ))
        )
          return Response.json({ error: "Configuration not found." }, { status: 404 });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...setPlayerLinkEnabled,
      method: "POST",
      path: "/admin/api/player-link/enabled",
      body: setPlayerLinkEnabled.body,
      success: setPlayerLinkEnabled.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "steamLink",
      handler: async ({ body }) => {
        const config = await options.stores.platformLink.readPlatformLinkConfig(
          body.guildId,
          body.platform,
        );
        if (!config) return Response.json({ error: "Configuration not found." }, { status: 404 });
        if (
          !(await options.stores.platformLink.setPlatformLinkEnabled(
            body.guildId,
            body.platform,
            body.enabled,
          ))
        )
          return Response.json({ error: "Configuration not found." }, { status: 404 });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...getWebhookProxy,
      method: "GET",
      path: "/admin/api/webhook-proxy",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      query: getWebhookProxy.query,
      access: guildScopedAccess("read"),
      success: getWebhookProxy.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const credentials = options.webhookCredentialService;
        if (!credentials) {
          return Response.json(
            { error: "Webhook credential service is unavailable" },
            { status: 503 },
          );
        }
        const configs = await options.stores.webhookProxy.listWebhookProxyConfigs(guildId);
        return Response.json({
          guildId,
          configs: await Promise.all(
            configs.map((config) => adminWebhookProxyConfig(credentials, config)),
          ),
        });
      },
    }),
    defineRoute({
      ...getWebhookProxyIngressHealth,
      method: "GET",
      path: "/admin/api/webhook-proxy/ingress-health",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      query: getWebhookProxyIngressHealth.query,
      access: guildScopedAccess("read"),
      success: getWebhookProxyIngressHealth.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const publicId = query.publicId;
        if (!publicId || !options.webhookIngressGuard) {
          return Response.json({ error: "Ingress health is unavailable" }, { status: 503 });
        }
        const config = await options.stores.webhookProxy.readWebhookProxyConfig(publicId);
        if (!config || config.guildId !== guildId) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const nowMs = Date.now();
        const [source, global, invalidSources] = await Promise.all([
          options.webhookIngressGuard
            .getByName(`source:v1:webhook-proxy:${publicId}`)
            .snapshot(nowMs),
          options.webhookIngressGuard.getByName("global:v2:webhook-proxy").snapshot(nowMs),
          options.webhookIngressGuard
            .getByName("invalid-source:v1:webhook-proxy:global")
            .snapshot(nowMs),
        ]);
        return Response.json(
          { guildId, publicId, product: "webhook-proxy", source, global, invalidSources },
          { headers: { "cache-control": "no-store" } },
        );
      },
    }),
    defineRoute({
      ...saveWebhookProxy,
      method: "POST",
      path: "/admin/api/webhook-proxy/config",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      body: saveWebhookProxy.body,
      access: bodyGuildScopedAccess("write"),
      success: saveWebhookProxy.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body, request, adminRequest }) =>
        saveWebhookProxyConfig(
          options,
          body,
          await integrationConfigurationActor(options, request, adminRequest),
        ),
    }),
    defineRoute({
      ...revealWebhookProxyCredential,
      method: "POST",
      path: "/admin/api/webhook-proxy/credential/reveal",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      body: revealWebhookProxyCredential.body,
      access: bodyGuildScopedAccess("write"),
      success: revealWebhookProxyCredential.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body, request }) => {
        const credentials = options.webhookCredentialService;
        if (!credentials) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const config = await options.stores.webhookProxy.readWebhookProxyConfig(body.publicId);
        const destination = config?.destinations.find((entry) => entry.id === body.destinationId);
        if (!config || config.guildId !== body.guildId || !destination) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const revealed = await credentials.reveal(destination.credentialId, {
          kind: "proxy_destination",
          guildId: body.guildId,
          publicId: body.publicId,
          destinationId: body.destinationId,
        });
        const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
        await postWebhookCredentialRevealAuditEvent(
          {
            guildId: body.guildId,
            actorUserId,
            publicId: body.publicId,
            destinationId: body.destinationId,
            fingerprint: revealed.fingerprint,
          },
          options.stores.guildAuditLog,
          options.discordBotToken,
        );
        return Response.json(
          {
            url: revealed.url,
            fingerprint: revealed.fingerprint,
            expiresAtMs: Date.now() + 30_000,
          },
          { headers: REVEAL_RESPONSE_HEADERS },
        );
      },
    }),
    defineRoute({
      ...revealWebhookProxyBanCredential,
      method: "POST",
      path: "/admin/api/webhook-proxy/ban-notification-credential/reveal",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      body: revealWebhookProxyBanCredential.body,
      access: bodyGuildScopedAccess("write"),
      success: revealWebhookProxyBanCredential.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body, request }) => {
        const credentials = options.webhookCredentialService;
        if (!credentials) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const config = await options.stores.webhookProxy.readWebhookProxyConfig(body.publicId);
        if (!config || config.guildId !== body.guildId || !config.banLookupCredentialId) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const revealed = await credentials.reveal(config.banLookupCredentialId, {
          kind: "ban_lookup_notification",
          guildId: body.guildId,
          publicId: body.publicId,
        });
        const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
        await postWebhookCredentialRevealAuditEvent(
          {
            guildId: body.guildId,
            actorUserId,
            publicId: body.publicId,
            destinationId: "ban-lookup-notification",
            fingerprint: revealed.fingerprint,
          },
          options.stores.guildAuditLog,
          options.discordBotToken,
        );
        return Response.json(
          {
            url: revealed.url,
            fingerprint: revealed.fingerprint,
            expiresAtMs: Date.now() + 30_000,
          },
          { headers: REVEAL_RESPONSE_HEADERS },
        );
      },
    }),
    defineRoute({
      ...deleteWebhookProxy,
      method: "POST",
      path: "/admin/api/webhook-proxy/delete",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      body: deleteWebhookProxy.body,
      access: bodyGuildScopedAccess("write"),
      success: deleteWebhookProxy.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body, request, adminRequest }) => {
        const existing = await options.stores.webhookProxy.readWebhookProxyConfig(body.publicId);
        if (!existing || existing.guildId !== body.guildId) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "webhook-proxy",
            resourceKey: body.publicId,
            current: existing,
            next: null,
            adapter: webhookProxyRevisionAdapter,
            actor: await integrationConfigurationActor(options, request, adminRequest),
          },
          commitFree: () => options.stores.webhookProxy.deleteWebhookProxyConfig(body),
        });
        const credentials = options.webhookCredentialService;
        if (credentials) {
          for (const destination of existing.destinations) {
            await credentials.remove(destination.credentialId, {
              kind: "proxy_destination",
              guildId: body.guildId,
              publicId: body.publicId,
              destinationId: destination.id,
            });
          }
          if (existing.banLookupCredentialId) {
            await credentials.remove(existing.banLookupCredentialId, {
              kind: "ban_lookup_notification",
              guildId: body.guildId,
              publicId: body.publicId,
            });
          }
        }
        options.invalidateWebhookProxyConfig?.(body.publicId);
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...listWebhookProxyLogs,
      method: "GET",
      path: "/admin/api/webhook-proxy/logs",
      feature: "webhookProxy",
      paidOnly: "premium-only-features",
      query: listWebhookProxyLogs.query,
      access: ({ query }) => {
        const queryRecord = query as
          | { guildId?: unknown; publicId?: unknown; workspaceId?: unknown }
          | undefined;
        const guildId =
          typeof queryRecord?.guildId === "string" && queryRecord.guildId.length > 0
            ? queryRecord.guildId
            : null;
        const publicId =
          typeof queryRecord?.publicId === "string" && queryRecord.publicId.length > 0
            ? queryRecord.publicId
            : null;
        if (!guildId || !publicId) {
          return Response.json({ error: "guildId and publicId are required" }, { status: 400 });
        }
        const workspaceId =
          typeof queryRecord?.workspaceId === "string" && queryRecord.workspaceId.length > 0
            ? queryRecord.workspaceId
            : undefined;
        return workspaceId ? { mode: "read", guildId, workspaceId } : { mode: "read", guildId };
      },
      success: listWebhookProxyLogs.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const publicId = query.publicId as string;
        const limit = Number.parseInt(query.limit ?? "20", 10);
        return Response.json({
          guildId,
          publicId,
          logs: await options.stores.webhookProxy.listWebhookProxyForwardLogs(
            guildId,
            publicId,
            limit,
          ),
        });
      },
    }),
    defineRoute({
      ...getPlayerCount,
      method: "GET",
      path: "/admin/api/player-count",
      feature: "playerCount",
      paidOnly: "premium-only-features",
      query: getPlayerCount.query,
      access: guildScopedAccess("read"),
      success: getPlayerCount.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const servers = await options.services.playerCountService.listServers(guildId);
        const targets = (await options.wardogs?.list(guildId)) ?? [];
        return Response.json({
          guildId,
          servers,
          wardogs: {
            enabled: options.wardogsPlayerCountEnabled ?? false,
            targets: await Promise.all(
              targets.map(async (target) => {
                const state = await options.wardogs!.statusReadiness(guildId, target.id);
                return {
                  id: target.id,
                  name: target.name,
                  ready: state.ready,
                  reason: state.error,
                };
              }),
            ),
          },
        });
      },
    }),
    defineRoute({
      ...savePlayerCountServer,
      method: "POST",
      path: "/admin/api/player-count/server",
      feature: "playerCount",
      paidOnly: "premium-only-features",
      body: savePlayerCountServer.body,
      access: bodyGuildScopedAccess("write"),
      success: savePlayerCountServer.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body }) => {
        const resources = await resolveGuildResources(options).forGuild(body.guildId);
        if (body.channelId) resources.requireVoiceChannel(body.channelId);
        if (body.alertChannelId) resources.requireTextChannel(body.alertChannelId);
        if (body.provider === "wardogs-rcon") {
          const state = await options.wardogs?.statusReadiness(body.guildId, body.providerServerId);
          if (!state?.target)
            return Response.json(
              { error: "WARDOGS target is unavailable for this Guild." },
              { status: 400 },
            );
          if (body.steamHost != null || body.steamPort != null)
            return Response.json(
              { error: "WARDOGS uses its secure target, not Steam query fields." },
              { status: 400 },
            );
        }
        const now = Date.now();
        const displayFormat = body.displayFormat ?? "🎮 Players: {count}/{max}";
        const offlineFormat = body.offlineFormat ?? "🎮 Players: Offline";

        const displayFormatError = assertFormatLength(displayFormat, "displayFormat");
        if (displayFormatError) {
          return Response.json({ error: displayFormatError }, { status: 400 });
        }
        const offlineFormatError = assertFormatLength(offlineFormat, "offlineFormat");
        if (offlineFormatError) {
          return Response.json({ error: offlineFormatError }, { status: 400 });
        }

        if (body.id) {
          const existing = await options.stores.playerCount.readPlayerCountServer(body.id);
          if (!existing) {
            return Response.json({ error: "Server not found" }, { status: 404 });
          }
          if (existing.guildId !== body.guildId) {
            return Response.json({ error: "Server belongs to another guild." }, { status: 409 });
          }
          const steamHost =
            body.provider === "wardogs-rcon"
              ? null
              : body.steamHost === undefined
                ? existing.steamHost
                : body.steamHost;
          const steamPort =
            body.provider === "wardogs-rcon"
              ? null
              : body.steamPort === undefined
                ? existing.steamPort
                : body.steamPort;
          const replacing =
            existing.provider !== body.provider ||
            existing.providerServerId !== body.providerServerId ||
            existing.steamHost !== steamHost ||
            existing.steamPort !== steamPort;
          if (
            replacing &&
            existing.channelId &&
            existing.lastFetchedAtMs !== null &&
            !body.confirmReplacement
          )
            return Response.json(
              { error: "Confirm replacing the displayed server before saving." },
              { status: 409 },
            );
          await options.stores.playerCount.upsertPlayerCountServer({
            ...existing,
            ...(replacing
              ? {
                  lastPlayerCount: null,
                  lastMaxSlots: null,
                  lastQueueSize: null,
                  lastFetchedAtMs: null,
                  consecutiveFailureCount: 0,
                  lastErrorMessage: null,
                  lastErrorAtMs: null,
                }
              : {}),
            name: body.name,
            provider: body.provider as PlayerCountServer["provider"],
            providerServerId: body.providerServerId,
            channelId: body.channelId === undefined ? existing.channelId : body.channelId,
            alertChannelId:
              body.alertChannelId === undefined ? existing.alertChannelId : body.alertChannelId,
            refreshIntervalMinutes: body.refreshIntervalMinutes ?? existing.refreshIntervalMinutes,
            displayFormat: body.displayFormat ?? existing.displayFormat,
            offlineFormat: body.offlineFormat ?? existing.offlineFormat,
            failureThreshold: body.failureThreshold ?? existing.failureThreshold,
            steamHost,
            steamPort,
            updatedAtMs: now,
          });
          if (replacing)
            await options.services.playerCountService.clearFailureAlerts(body.guildId, body.id);
          return Response.json({ ok: true });
        }

        const existingByName = await options.stores.playerCount.listPlayerCountServers(
          body.guildId,
        );
        if (existingByName.some((s) => s.name === body.name)) {
          return Response.json(
            { error: `A server named "${body.name}" already exists.` },
            { status: 409 },
          );
        }

        await options.stores.playerCount.upsertPlayerCountServer({
          id: crypto.randomUUID(),
          guildId: body.guildId,
          name: body.name,
          provider: body.provider as PlayerCountServer["provider"],
          providerServerId: body.providerServerId,
          channelId: body.channelId ?? null,
          alertChannelId: body.alertChannelId ?? null,
          refreshIntervalMinutes: body.refreshIntervalMinutes ?? 10,
          displayFormat,
          offlineFormat,
          failureThreshold: body.failureThreshold ?? 3,
          renameOffsetMinutes: Math.floor(Math.random() * 10),
          lastRenamedAtMs: null,
          lastPlayerCount: null,
          lastMaxSlots: null,
          lastQueueSize: null,
          lastFetchedAtMs: null,
          consecutiveFailureCount: 0,
          lastErrorMessage: null,
          lastErrorAtMs: null,
          steamHost: body.steamHost ?? null,
          steamPort: body.steamPort ?? null,
          createdAtMs: now,
          updatedAtMs: now,
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...deletePlayerCountServer,
      method: "POST",
      path: "/admin/api/player-count/delete",
      feature: "playerCount",
      paidOnly: "premium-only-features",
      body: deletePlayerCountServer.body,
      access: bodyGuildScopedAccess("write"),
      success: deletePlayerCountServer.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body, request }) => {
        const playerCountService = options.services.playerCountService;
        const actorUserId =
          (await options.readCustomerAdminSession?.(request))?.user.discordUserId ?? "admin-ui";
        const deleted = await playerCountService.deleteServer(body.guildId, body.id, actorUserId);
        if (!deleted) {
          return Response.json({ error: "Server not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...testPlayerCount,
      method: "POST",
      path: "/admin/api/player-count/test",
      feature: "playerCount",
      paidOnly: "premium-only-features",
      body: testPlayerCount.body,
      access: bodyGuildScopedAccess("read"),
      success: testPlayerCount.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ body }) => {
        const service = options.services.playerCountService;
        const result = await service.testServerReachability(body.guildId, body.serverId);
        if (!result.ok && result.error === "Server not found") {
          return Response.json({ ok: false, error: result.error }, { status: 404 });
        }
        return Response.json(result);
      },
    }),

    defineRoute({
      ...getPlayerLink,
      method: "GET",
      path: "/admin/api/player-link",
      feature: "steamLink",
      query: getPlayerLink.query,
      access: guildScopedAccess("read"),
      success: getPlayerLink.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const platform = (query.platform ?? "steam") as "steam" | "xbox" | "playstation";
        const [config, links] = await Promise.all([
          options.stores.platformLink.readPlatformLinkConfig(guildId, platform),
          options.stores.platformLink.listPlatformLinks(guildId, platform),
        ]);

        return Response.json({ guildId, platform, config, links });
      },
    }),
    defineRoute({
      ...savePlayerLinkOperation,
      method: "POST",
      path: "/admin/api/player-link/config",
      feature: "steamLink",
      body: savePlayerLinkOperation.body,
      access: bodyGuildScopedAccess("write"),
      success: savePlayerLinkOperation.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: ({ body }) => savePlayerLinkConfig(options, body),
    }),
    defineRoute({
      ...publishPlayerLinkOperation,
      method: "POST",
      path: "/admin/api/player-link/publish",
      feature: "steamLink",
      body: publishPlayerLinkOperation.body,
      access: bodyGuildScopedAccess("write"),
      success: publishPlayerLinkOperation.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: ({ body }) => publishPlayerLinkPanel(options, body),
    }),
    defineRoute({
      ...syncPlayerLinkRolesOperation,
      method: "POST",
      path: "/admin/api/player-link/sync-roles",
      feature: "steamLink",
      body: syncPlayerLinkRolesOperation.body,
      access: bodyGuildScopedAccess("write"),
      success: syncPlayerLinkRolesOperation.success.schema,
      errors: adminErrorEnvelopeSchema,
      handler: ({ body }) => syncPlayerLinkRoles(options, body),
    }),
  ];
}

async function integrationConfigurationActor(
  options: IntegrationsAdminRoutesOptions,
  request: Request,
  adminRequest?: { operationId: string; correlationId: string },
): Promise<ConfigurationActorContext> {
  const session = options.readCustomerAdminSession
    ? await options.readCustomerAdminSession(request)
    : null;
  return {
    actorUserId: session?.user.discordUserId ?? null,
    source: "dashboard-save",
    operationId: adminRequest?.operationId ?? "webhookProxyConfig.post",
    correlationId: adminRequest?.correlationId ?? null,
  };
}

function createWebhookProxyPublicId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertFormatLength(format: string, label: string): string | null {
  const resolved = format.replace(/\{queue\?([^}]*)\}/g, "$1" + "99");
  const worstCase = resolved
    .replace(/{count}/g, "999")
    .replace(/{max}/g, "999")
    .replace(/{queue}/g, "99")
    .replace(/{name}/g, "a".repeat(50));
  if (worstCase.length > 100) {
    return `${label} may exceed Discord's 100-character channel name limit (worst case: ${worstCase.length} chars).`;
  }
  return null;
}

function parseSteamGameAppIds(rawIds: string[]): number[] {
  const normalized: number[] = [];
  const seen = new Set<number>();

  for (let index = 0; index < rawIds.length; index += 1) {
    const rawId = rawIds[index] ?? "";
    if (!/^\d+$/.test(rawId)) {
      throw new Error(`Invalid gameAppIds[${index}]`);
    }
    const parsed = Number.parseInt(rawId, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid gameAppIds[${index}]`);
    }
    if (!seen.has(parsed)) {
      seen.add(parsed);
      normalized.push(parsed);
    }
  }

  return normalized;
}
