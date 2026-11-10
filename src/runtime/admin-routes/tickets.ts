import type { z } from "zod";

import { createChannelMessage, DiscordApiError, uploadTranscriptToChannel } from "../../discord";
import { buildAuditEmbed, suppressMentions } from "../../discord/messages";
import type { TicketLinkPlatform, TicketPanelConfig, TicketTypeConfig } from "../../types";
import {
  summarizeConfigurationRevision,
  type ConfigurationActorContext,
} from "../../configuration-revisions";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import {
  getCachedGuildEmojis,
  getCachedGuildPermissionContext,
  getCachedGuildTicketResources,
  shouldRefreshAdminDiscordCache,
} from "../admin-discord-cache";
import type { AdminRoutesOptions } from "./index";
import { summarizeTicket } from "../../services/tickets/ai-transcript-summarizer";
import {
  createTicketPanelService,
  createDiscordTicketPanelAdapter,
  type TicketPanelResult,
  type TicketPanelTestAdapters,
} from "../../services/tickets/ticket-panel";
import {
  adminErrorEnvelopeSchema,
  ticketContracts,
  ticketPanelConfigSchema,
} from "../../contracts/admin";
import { buildTicketTranscriptPath, generateTicketTranscriptAccessToken } from "../../tickets";
import { TICKET_TRANSCRIPT_ACCESS_TTL_MS } from "../ticket-transcript-collector";

export function createTicketAdminRoutes(
  options: AdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...ticketContracts.revokeTranscript,
      success: ticketContracts.revokeTranscript.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body }) => {
        if (!options.ticketTranscriptCapabilities) {
          return Response.json(
            { error: "Ticket transcript access is unavailable." },
            { status: 503 },
          );
        }
        const revoked = await options.ticketTranscriptCapabilities.revoke({
          guildId: body.guildId,
          channelId: body.channelId,
          revokedAtMs: Date.now(),
        });
        return revoked
          ? Response.json({ ok: true })
          : Response.json({ error: "Ticket transcript not found." }, { status: 404 });
      },
    }),
    defineRoute({
      ...ticketContracts.rotateTranscript,
      success: ticketContracts.rotateTranscript.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body, request }) => {
        if (!options.ticketTranscriptCapabilities) {
          return Response.json(
            { error: "Ticket transcript access is unavailable." },
            { status: 503 },
          );
        }
        const accessToken = generateTicketTranscriptAccessToken();
        const rotatedAtMs = Date.now();
        const rotated = await options.ticketTranscriptCapabilities.rotate({
          guildId: body.guildId,
          channelId: body.channelId,
          accessToken,
          rotatedAtMs,
          expiresAtMs: rotatedAtMs + TICKET_TRANSCRIPT_ACCESS_TTL_MS,
        });
        if (!rotated)
          return Response.json({ error: "Ticket transcript not found." }, { status: 404 });
        const origin = options.publicBaseUrl ?? new URL(request.url).origin;
        return Response.json({
          url: new URL(
            buildTicketTranscriptPath(body.guildId, body.channelId, accessToken),
            origin,
          ).toString(),
          expiresAtMs: rotated.expiresAtMs,
        });
      },
    }),
    defineRoute({
      ...ticketContracts.panel,
      success: ticketContracts.panel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      feature: "tickets",
      handler: async ({ query }) => {
        const panel = await options.stores.tickets.readTicketPanelConfig(query.guildId);
        const panels = options.stores.tickets.listTicketPanelConfigs
          ? await options.stores.tickets.listTicketPanelConfigs(query.guildId)
          : panel
            ? [panel]
            : [];
        return Response.json({ panel, panels });
      },
    }),
    defineRoute({
      ...ticketContracts.createPanel,
      success: ticketContracts.createPanel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body, request, adminRequest }) => {
        const result = await getTicketPanelService(options).createPanel(
          body,
          await readConfigurationActor(options, request, adminRequest),
        );
        return result.ok
          ? Response.json({ ok: true, panel: result.value })
          : ticketPanelFailureResponse(result);
      },
    }),
    defineRoute({
      ...ticketContracts.savePanel,
      success: ticketContracts.savePanel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body, request, adminRequest }) => {
        const result = await getTicketPanelService(options).savePanel(
          normalizeTicketPanelConfig(body),
          await readConfigurationActor(options, request, adminRequest),
        );
        return result.ok
          ? Response.json({ ok: true, panel: result.value })
          : ticketPanelFailureResponse(result);
      },
    }),
    defineRoute({
      ...ticketContracts.revisions,
      success: ticketContracts.revisions.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      feature: "tickets",
      handler: async ({ query }) => {
        const page = await getTicketPanelService(options).listPanelRevisions({
          guildId: query.guildId,
          panelId: query.panelId,
          limit: parseRevisionLimit(query.limit ?? null),
          beforeCreatedAtMs: parseRevisionCursor(query.beforeCreatedAtMs ?? null),
        });
        return Response.json({
          revisions: page.revisions.map(summarizeConfigurationRevision),
          nextCursor: page.nextCursor,
        });
      },
    }),
    defineRoute({
      ...ticketContracts.revision,
      success: ticketContracts.revision.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      feature: "tickets",
      handler: async ({ query }) => {
        const detail = await getTicketPanelService(options).getPanelRevision({
          guildId: query.guildId,
          revisionId: query.revisionId,
        });
        return detail
          ? Response.json(detail)
          : Response.json({ error: "Ticket Panel revision not found." }, { status: 404 });
      },
    }),
    defineRoute({
      ...ticketContracts.restorePreview,
      success: ticketContracts.restorePreview.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      feature: "tickets",
      handler: async ({ body }) => {
        const signingSecret = requireConfigurationRevisionSigningSecret(options);
        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        try {
          return Response.json(
            await getTicketPanelService(options).preparePanelRestore({
              guildId: body.guildId,
              revisionId: body.revisionId,
              resources,
              signingSecret,
            }),
          );
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Revision restore preview failed." },
            { status: 409 },
          );
        }
      },
    }),
    defineRoute({
      ...ticketContracts.restore,
      success: ticketContracts.restore.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      feature: "tickets",
      handler: async ({ body, request, adminRequest }) => {
        const signingSecret = requireConfigurationRevisionSigningSecret(options);
        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        const result = await getTicketPanelService(options).restorePanelRevision({
          guildId: body.guildId,
          revisionId: body.revisionId,
          previewToken: body.previewToken,
          resources,
          signingSecret,
          actor: await readConfigurationActor(options, request, adminRequest),
        });
        return result.ok
          ? Response.json({
              ok: true,
              panel: result.value,
              followUpActions: result.value ? ["Publish or sync the Ticket Panel."] : [],
            })
          : ticketPanelFailureResponse(result);
      },
    }),
    defineRoute({
      ...ticketContracts.resources,
      success: ticketContracts.resources.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      feature: "tickets",
      handler: async ({ query, url }) => {
        const refresh = shouldRefreshAdminDiscordCache(url);
        const [resources, emojis, configuredTicketLinkPlatforms] = await Promise.all([
          getCachedGuildTicketResources(query.guildId, options.discordBotToken, refresh),
          getCachedGuildEmojis(query.guildId, options.discordBotToken, refresh).catch(() => []),
          readConfiguredTicketLinkPlatforms(options, query.guildId),
        ]);
        return Response.json({
          guildId: query.guildId,
          roles: resources.roles.map(({ id, name }) => ({ id, name })),
          categories: resources.channels
            .filter((channel) => channel.type === 4)
            .map(({ id, name }) => ({ id, name })),
          textChannels: resources.channels
            .filter((channel) => channel.type === 0)
            .map(({ id, name }) => ({ id, name })),
          voiceChannels: resources.channels
            .filter((channel) => channel.type === 2)
            .map(({ id, name }) => ({ id, name })),
          stageChannels: resources.channels
            .filter((channel) => channel.type === 13)
            .map(({ id, name }) => ({ id, name })),
          forumChannels: resources.channels
            .filter((channel) => channel.type === 15)
            .map(({ id, name }) => ({ id, name })),
          emojis: emojis
            .filter((emoji) => emoji.id && emoji.name)
            .map((emoji) => ({
              id: emoji.id as string,
              name: emoji.name as string,
              animated: emoji.animated === true,
              available: emoji.available !== false,
            })),
          configuredTicketLinkPlatforms,
        });
      },
    }),
    defineRoute({
      ...ticketContracts.closed,
      success: ticketContracts.closed.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      feature: "tickets",
      handler: async ({ query }) =>
        Response.json(
          await options.stores.tickets.listClosedTicketInstances({
            guildId: query.guildId,
            panelId: query.panelId ?? null,
            limit: parseClosedTicketsLimit(query.limit ?? null),
            beforeOpenedAtMs: parseClosedTicketsCursor(query.beforeOpenedAtMs ?? null),
          }),
        ),
    }),
    defineRoute({
      ...ticketContracts.setupCheck,
      success: ticketContracts.setupCheck.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      feature: "tickets",
      handler: async ({ query, url }) => {
        const panel = await readTicketPanelForAdminAction(options, query.guildId, query.panelId);
        const refresh = shouldRefreshAdminDiscordCache(url);
        const [blocklistConfig, entitlement] = await Promise.all([
          options.stores.blocklist.readConfig(),
          options.stores.guildEntitlements.readGuildEntitlement(query.guildId),
        ]);
        const context = await getCachedGuildPermissionContext(
          query.guildId,
          blocklistConfig.botUserId,
          options.discordBotToken,
          refresh,
        );
        return Response.json(
          getTicketPanelService(options).diagnose({
            guildId: query.guildId,
            panel,
            context,
            isPremiumGuild: entitlement.tier !== "free",
            aiSummariesAvailable: Boolean(options.aiTranscriptSummarizerEnv),
          }),
        );
      },
    }),
    defineRoute({
      ...ticketContracts.testAction,
      success: ticketContracts.testAction.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body }) => {
        const result = await getTicketPanelService(options).testAction(
          { guildId: body.guildId, panelId: body.panelId, action: body.action },
          createTicketPanelTestAdapters(options),
        );
        return Response.json(result, {
          status: result.ok
            ? 200
            : body.action === "ai-summary" && /requires a paid plan/.test(result.message)
              ? 402
              : result.status === "skipped"
                ? 409
                : 502,
        });
      },
    }),
    defineRoute({
      ...ticketContracts.publishPanel,
      success: ticketContracts.publishPanel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body }) => {
        const panel = normalizeTicketPanelConfig(body);
        const resources = await getCachedGuildTicketResources(
          panel.guildId,
          options.discordBotToken,
          true,
        );
        const service = getTicketPanelService(options);
        const result = await service.publishPanel({ panel, resources });
        if (!result.ok && result.recovery) {
          const recovered = await service.resumeRecovery(result.recovery);
          if (recovered.ok && result.recovery.operation === "publish") {
            return Response.json({ ok: true, panelMessageId: result.recovery.messageId });
          }
          await deferPanelRecovery(service, recovered);
        }
        return result.ok
          ? Response.json({ ok: true, panelMessageId: result.value.panelMessageId })
          : ticketPanelFailureResponse(result);
      },
    }),
    defineRoute({
      ...ticketContracts.unpublishPanel,
      success: ticketContracts.unpublishPanel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body }) => {
        const service = getTicketPanelService(options);
        const result = await service.unpublishPanel(body);
        if (!result.ok && result.recovery) {
          const recovered = await service.resumeRecovery(result.recovery);
          if (recovered.ok) return Response.json({ ok: true, panel: recovered.value });
          await deferPanelRecovery(service, recovered);
        }
        return result.ok
          ? Response.json({ ok: true, panel: result.value })
          : ticketPanelFailureResponse(result);
      },
    }),
    defineRoute({
      ...ticketContracts.deletePanel,
      success: ticketContracts.deletePanel.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      feature: "tickets",
      handler: async ({ body, request, adminRequest }) => {
        const service = getTicketPanelService(options);
        const result = await service.deletePanel(
          body,
          await readConfigurationActor(options, request, adminRequest),
        );
        if (!result.ok && result.recovery) {
          const recovered = await service.resumeRecovery(result.recovery);
          if (recovered.ok) return Response.json({ ok: true });
          await deferPanelRecovery(service, recovered);
        }
        return result.ok ? Response.json({ ok: true }) : ticketPanelFailureResponse(result);
      },
    }),
  ];
}

async function readConfigurationActor(
  options: AdminRoutesOptions,
  request: Request,
  adminRequest?: { operationId: string; correlationId: string },
): Promise<ConfigurationActorContext> {
  const session = options.readCustomerAdminSession
    ? await options.readCustomerAdminSession(request)
    : null;
  return {
    actorUserId: session?.user.discordUserId ?? null,
    source: "dashboard-save",
    operationId: adminRequest?.operationId ?? "ticketsPanel.post",
    correlationId: adminRequest?.correlationId ?? null,
  };
}

function getTicketPanelService(options: AdminRoutesOptions) {
  const guildResources = options.guildResources!;
  return (
    options.services?.ticketPanelService ??
    createTicketPanelService({
      store: options.stores.tickets,
      entitlements: options.stores.guildEntitlements,
      guildResources,
      configurationRevisions: options.stores.configurationRevisions,
      discord: createDiscordTicketPanelAdapter({
        discordBotToken: options.discordBotToken,
        auditStore: options.stores.guildAuditLog,
        guildResources,
      }),
    })
  );
}

async function deferPanelRecovery(
  service: ReturnType<typeof createTicketPanelService>,
  result: Awaited<ReturnType<ReturnType<typeof createTicketPanelService>["resumeRecovery"]>>,
): Promise<void> {
  if (result.ok || result.code !== "partial-success" || !result.recovery) return;
  try {
    if (!(await service.deferRecovery(result.recovery))) {
      console.error("Ticket recovery queue is not configured", "panel-recovery");
    }
  } catch (error) {
    console.error("Failed to enqueue ticket recovery", "panel-recovery", error);
  }
}

function ticketPanelFailureResponse(
  failure: Extract<TicketPanelResult<unknown>, { ok: false }>,
): Response {
  const status =
    failure.code === "plan-limit"
      ? 402
      : failure.code === "not-found"
        ? 404
        : failure.code === "provider-failure"
          ? 502
          : failure.code === "open-tickets"
            ? 409
            : failure.code === "unsupported"
              ? 501
              : 400;
  return Response.json({ error: failure.message }, { status });
}

function normalizeTicketPanelConfig(
  body: z.input<typeof ticketPanelConfigSchema>,
): TicketPanelConfig {
  const { workspaceId: _workspaceId, ...rest } = body;
  return {
    ...rest,
    panelEmoji: body.panelEmoji ?? null,
    panelTitle: body.panelTitle ?? null,
    panelDescription: body.panelDescription ?? null,
    panelFooter: body.panelFooter ?? null,
    panelColor: body.panelColor ?? 0x57f287,
    panelMessageId: body.panelMessageId ?? null,
    ticketCreationLimit: body.ticketCreationLimit ?? null,
    ticketLimitRejectionMessage: body.ticketLimitRejectionMessage ?? null,
    enableTicketClaiming: body.enableTicketClaiming ?? false,
    aiTranscriptSummariesEnabled: body.aiTranscriptSummariesEnabled ?? false,
    ticketTypes: body.ticketTypes.map((ticketType) => ({
      ...ticketType,
      autoReplyMessage: ticketType.autoReplyMessage ?? null,
      autoReplyEnabled: ticketType.autoReplyEnabled ?? ticketType.autoReplyMessage !== null,
      responseRules: normalizeTicketTypeResponseRules(ticketType),
      anonymousEnabled: ticketType.anonymousEnabled ?? false,
      anonymousSupportEnabled:
        ticketType.anonymousSupportEnabled ?? ticketType.anonymousEnabled ?? false,
      staffDiscussionThreadEnabled:
        ticketType.staffDiscussionThreadEnabled ?? ticketType.anonymousEnabled ?? false,
      ticketHistoryPromptVisibility: ticketType.ticketHistoryPromptVisibility ?? "off",
      participantManagementEnabled: ticketType.participantManagementEnabled ?? false,
      limitExclusion: ticketType.limitExclusion ?? false,
      mentionSupportRole: ticketType.mentionSupportRole ?? false,
    })),
  };
}

function normalizeTicketTypeResponseRules(value: {
  responseRules?: unknown;
  autoReplyEnabled?: unknown;
  autoReplyMessage?: unknown;
}): NonNullable<TicketTypeConfig["responseRules"]> {
  if (Array.isArray(value.responseRules)) {
    return value.responseRules as NonNullable<TicketTypeConfig["responseRules"]>;
  }

  if (value.autoReplyEnabled === false) {
    return [];
  }

  if (typeof value.autoReplyMessage !== "string" || value.autoReplyMessage.trim().length === 0) {
    return [];
  }

  return [
    {
      id: "legacy-auto-reply",
      conditions: [],
      message: value.autoReplyMessage,
    },
  ];
}

async function readConfiguredTicketLinkPlatforms(
  options: AdminRoutesOptions,
  guildId: string,
): Promise<TicketLinkPlatform[]> {
  const [steam, xbox, playstation] = await Promise.all([
    options.stores.platformLink.readPlatformLinkConfig(guildId, "steam"),
    options.stores.platformLink.readPlatformLinkConfig(guildId, "xbox"),
    options.stores.platformLink.readPlatformLinkConfig(guildId, "playstation"),
  ]);

  return [
    ...(steam?.linkedRoleId ? ["steam" as const] : []),
    ...(xbox?.linkedRoleId ? ["xbox" as const] : []),
    ...(playstation?.linkedRoleId ? ["playstation" as const] : []),
  ];
}

function parseRevisionLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 25;
}

function requireConfigurationRevisionSigningSecret(options: AdminRoutesOptions): string {
  if (!options.configurationRevisionSigningSecret) {
    throw new Error("Configuration revision restore is temporarily unavailable.");
  }
  return options.configurationRevisionSigningSecret;
}

function parseRevisionCursor(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseClosedTicketsLimit(value: string | null): number {
  if (!value) return 20;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, Math.floor(parsed))) : 20;
}

function parseClosedTicketsCursor(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readTicketPanelForAdminAction(
  options: AdminRoutesOptions,
  guildId: string,
  panelId: string | undefined,
): Promise<TicketPanelConfig | null> {
  if (panelId && options.stores.tickets.readTicketPanelConfigById) {
    return await options.stores.tickets.readTicketPanelConfigById(guildId, panelId);
  }
  return await options.stores.tickets.readTicketPanelConfig(guildId);
}

function createTicketPanelTestAdapters(options: AdminRoutesOptions): TicketPanelTestAdapters {
  return {
    async postPanelMessage(channelId) {
      await createChannelMessage(
        channelId,
        {
          content: "Ticket panel test message from HAF Bot. You can delete this message.",
          allowed_mentions: suppressMentions(),
        },
        options.discordBotToken,
      );
    },
    async uploadTranscript(channelId) {
      await uploadTranscriptToChannel(
        channelId,
        "ticket-transcript-test.txt",
        "This is a test ticket transcript from HAF Bot.",
        options.discordBotToken,
        {
          embeds: [
            buildAuditEmbed({
              title: "Ticket Transcript Test",
              description: "Transcript uploads are working for this channel.",
              color: 5_763_719,
              fields: [],
            }),
          ],
        },
      );
    },
    aiSummariesAvailable: Boolean(options.aiTranscriptSummarizerEnv),
    async testAiSummary(panel) {
      if (!options.aiTranscriptSummarizerEnv) return false;
      return Boolean(
        await summarizeTicket(
          {
            ticketTypeLabel: panel.ticketTypes[0]?.label ?? "Support",
            ticketTypeId: panel.ticketTypes[0]?.id ?? "support",
            answers: [{ label: "Test", value: "Confirm AI summaries can run." }],
            messages: [
              {
                authorId: "member",
                authorTag: "Member",
                content: "I need help testing ticket summaries.",
                createdAtMs: Date.now() - 1_000,
              },
              {
                authorId: "staff",
                authorTag: "Staff",
                content: "We confirmed the transcript summary test is working.",
                createdAtMs: Date.now(),
              },
            ],
            closerDisplayName: "HAF Bot",
          },
          options.aiTranscriptSummarizerEnv,
        ),
      );
    },
    formatError: formatTicketTestActionError,
  };
}

function formatTicketTestActionError(error: unknown): string {
  if (error instanceof DiscordApiError) {
    if (error.status === 403 || error.status === 404) {
      return "Discord rejected the test. Check the selected channel and the bot's permissions.";
    }
    if (error.status === 429) {
      return "Discord is rate limiting test actions. Try again shortly.";
    }
  }
  return "The test could not be completed. Check the setup results and try again.";
}
