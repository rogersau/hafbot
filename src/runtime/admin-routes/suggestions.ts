import { z } from "zod";
import { ensureForumTags } from "../../discord/channels";
import { getGuildPermissionResources } from "../../discord/guilds";
import { buildSuggestionPanel, createManagedSuggestionWebhook } from "../../discord/suggestions";
import { createChannelMessage, editChannelMessage } from "../../discord/messages";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import type { SuggestionService } from "../../services/suggestion-service";
import type { WebhookCredentialService } from "../../security/webhook-credentials/store";
import {
  SUGGESTION_STATUSES,
  defaultSuggestionsConfig,
  type SuggestionStatus,
} from "../../suggestions";
import type { RuntimeStores } from "../app-types";
import {
  DISCORD_PERMISSION_FLAGS,
  getChannelPermissions,
  hasPermission,
} from "../admin-permissions";
import {
  bodyGuildScopedAccess,
  guildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import { defineRoute, type Route } from "../admin-route-registry";
import type { CustomerSession } from "../auth/customer-session";

const guildQuery = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});
const promptSchema = z.object({
  id: z.string().trim().min(1).max(50),
  label: z.string().trim().min(1).max(45),
  required: z.boolean(),
});
const configBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  enabled: z.boolean(),
  forumChannelId: z.string().nullable(),
  panelChannelId: z.string().nullable(),
  panelTitle: z.string().min(1).max(256),
  panelBody: z.string().min(1).max(4000),
  panelButtonText: z.string().min(1).max(80),
  prompts: z.array(promptSchema).min(1).max(4),
  categories: z.array(z.string().trim().min(1).max(20)).max(14),
  modRoleIds: z.array(z.string()),
  modQueueChannelId: z.string().nullable(),
  voterRoleId: z.string().nullable(),
  minimumTenureDays: z.number().int().min(0).max(3650),
  collapseThreshold: z.number().int().min(2).max(100),
  submissionCooldownSeconds: z.number().int().min(0).max(86400),
  activeSuggestionLimit: z.number().int().min(1).max(100),
  digestEnabled: z.boolean(),
  digestChannelId: z.string().nullable(),
  digestCadenceDays: z.number().int().min(1).max(30),
});
const detailQuery = guildQuery.extend({ suggestionId: z.string().min(1) });
const transitionBody = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  suggestionId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  toStatus: z.enum(SUGGESTION_STATUSES),
  reason: z.string().max(500).optional(),
  outcome: z
    .object({
      summary: z.string().min(1).max(2000),
      nextStepOrLink: z.string().max(500).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export function createSuggestionsAdminRoutes(options: {
  stores: RuntimeStores;
  service?: SuggestionService;
  token: string;
  botUserId?: string;
  guildResources?: GuildResourceValidator;
  webhookCredentialService?: WebhookCredentialService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  const guildResources =
    options.guildResources ?? createDiscordGuildResourceValidator(options.token);
  const store = options.stores.suggestions;
  if (!store) return [];
  return [
    defineRoute({
      operationId: "suggestions.get",
      method: "GET",
      path: "/admin/api/suggestions",
      feature: "suggestions",
      query: guildQuery,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const config = (await store.readConfig(guildId)) ?? defaultSuggestionsConfig(guildId);
        const suggestions = await store.listSuggestions(guildId);
        const collapsedReplies = (
          await Promise.all(
            suggestions.map((item) => store.listConsideredReplies(guildId, item.id)),
          )
        )
          .flat()
          .filter((reply) => reply.state === "collapsed");
        const ready = await readiness(config, options);
        return Response.json({
          guildId,
          config: publicConfig(config),
          suggestions,
          collapsedReplies,
          readiness: ready,
        });
      },
    }),
    defineRoute({
      operationId: "suggestions.detail",
      method: "GET",
      path: "/admin/api/suggestions/detail",
      feature: "suggestions",
      query: detailQuery,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const suggestion = await store.readSuggestion(guildId, query.suggestionId);
        if (!suggestion) return Response.json({ error: "Suggestion not found" }, { status: 404 });
        const [revisions, statusHistory, replies, votes] = await Promise.all([
          store.listRevisions(guildId, suggestion.id),
          store.listStatusEvents(guildId, suggestion.id),
          store.listConsideredReplies(guildId, suggestion.id),
          store.listVotes(guildId, suggestion.id),
        ]);
        const replyFlags = Object.fromEntries(
          await Promise.all(
            replies.map(async (reply) => [
              reply.id,
              await store.listReplyFlagMemberIds(guildId, reply.id),
            ]),
          ),
        );
        return Response.json({ suggestion, revisions, statusHistory, replies, votes, replyFlags });
      },
    }),
    defineRoute({
      operationId: "suggestions.config.update",
      method: "PUT",
      path: "/admin/api/suggestions/config",
      feature: "suggestions",
      body: configBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service) return unavailable();
        const resources = await guildResources.forGuild(body.guildId);
        if (body.forumChannelId) resources.requireForumChannel(body.forumChannelId);
        if (body.panelChannelId) resources.requireTextChannel(body.panelChannelId);
        if (body.modQueueChannelId) resources.requireTextChannel(body.modQueueChannelId);
        if (body.digestChannelId) resources.requireTextChannel(body.digestChannelId);
        resources.requireRoles(body.modRoleIds);
        if (body.voterRoleId) resources.requireRole(body.voterRoleId);
        const current = await options.service.getConfig(body.guildId);
        const { workspaceId: _workspaceId, ...editable } = body;
        const config = await options.service.updateConfig(
          {
            ...current,
            ...editable,
          },
          await actor(options.readCustomerAdminSession, request),
        );
        return Response.json({
          config: publicConfig(config),
          readiness: await readiness(config, options),
        });
      },
    }),
    defineRoute({
      operationId: "suggestions.panel.publish",
      method: "POST",
      path: "/admin/api/suggestions/panel/publish",
      feature: "suggestions",
      body: z.object({
        guildId: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service) return unavailable();
        let config = await options.service.getConfig(body.guildId);
        if (!config.forumChannelId || !config.panelChannelId) {
          return Response.json(
            { error: "Choose a Suggestion Channel and Panel channel first." },
            { status: 409 },
          );
        }
        const resources = await guildResources.forGuild(body.guildId);
        resources.requireForumChannel(config.forumChannelId);
        resources.requireTextChannel(config.panelChannelId);
        if (config.modQueueChannelId) resources.requireTextChannel(config.modQueueChannelId);
        if (config.digestChannelId) resources.requireTextChannel(config.digestChannelId);
        resources.requireRoles(config.modRoleIds);
        if (config.voterRoleId) resources.requireRole(config.voterRoleId);
        const labels: Record<SuggestionStatus, string> = {
          gathering_feedback: "Gathering Feedback",
          needs_work: "Needs Work",
          under_review: "Under Review",
          planned: "Planned",
          implemented: "Implemented",
          rejected: "Rejected",
        };
        const tags = await ensureForumTags(
          config.forumChannelId,
          [...Object.values(labels), ...config.categories],
          options.token,
        );
        const statusTagIds = Object.fromEntries(
          Object.entries(labels)
            .map(([status, label]) => [status, tags.find((tag) => tag.name === label)?.id])
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
        const categoryTagIds = Object.fromEntries(
          config.categories
            .map((category) => [category, tags.find((tag) => tag.name === category)?.id])
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
        if (!options.webhookCredentialService) {
          return Response.json(
            { error: "Encrypted webhook credential storage is unavailable." },
            { status: 503 },
          );
        }
        let replyWebhookId = config.replyWebhookId;
        let replyWebhookCredentialId = config.replyWebhookCredentialId;
        if (!replyWebhookId || !replyWebhookCredentialId) {
          const created = await createManagedSuggestionWebhook(
            config.forumChannelId,
            options.token,
          );
          const credential = await options.webhookCredentialService.replace(
            {
              kind: "suggestion_reply",
              guildId: body.guildId,
              publicId: "reply-webhook",
            },
            `https://discord.com/api/webhooks/${created.id}/${created.token}`,
          );
          replyWebhookId = created.id;
          replyWebhookCredentialId = credential.credentialId;
        }
        const panel = buildSuggestionPanel(config);
        let panelMessageId = config.panelMessageId;
        if (panelMessageId) {
          try {
            await editChannelMessage(config.panelChannelId, panelMessageId, panel, options.token);
          } catch {
            panelMessageId = null;
          }
        }
        if (!panelMessageId) {
          panelMessageId = (await createChannelMessage(config.panelChannelId, panel, options.token))
            .id;
        }
        config = await options.service.updateConfig(
          {
            ...config,
            panelMessageId,
            statusTagIds,
            categoryTagIds,
            replyWebhookId,
            replyWebhookCredentialId,
          },
          await actor(options.readCustomerAdminSession, request),
        );
        await options.service.recordPanelPublished(
          body.guildId,
          await actor(options.readCustomerAdminSession, request),
        );
        return Response.json({
          config: publicConfig(config),
          readiness: await readiness(config, options),
        });
      },
    }),
    defineRoute({
      operationId: "suggestions.transition",
      method: "POST",
      path: "/admin/api/suggestions/transition",
      feature: "suggestions",
      body: transitionBody,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service) return unavailable();
        const actorUserId = await actor(options.readCustomerAdminSession, request);
        const suggestion = await options.service.transition({
          guildId: body.guildId,
          suggestionId: body.suggestionId,
          actorUserId,
          actorRoleIds: [],
          isGuildAdmin: true,
          isAuthor: false,
          expectedRevision: body.expectedRevision,
          toStatus: body.toStatus,
          reason: body.reason,
          outcome: body.outcome,
        });
        return Response.json({ suggestion });
      },
    }),
    defineRoute({
      operationId: "suggestions.projection.repair",
      method: "POST",
      path: "/admin/api/suggestions/repair",
      feature: "suggestions",
      body: z.object({
        guildId: z.string().min(1),
        workspaceId: z.string().min(1).optional(),
        suggestionId: z.string().min(1),
      }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        if (!options.service) return unavailable();
        const suggestion = await options.service.repairProjection(
          body.guildId,
          body.suggestionId,
          await actor(options.readCustomerAdminSession, request),
        );
        return Response.json({ suggestion });
      },
    }),
  ];
}

async function readiness(
  config: Awaited<ReturnType<SuggestionService["getConfig"]>>,
  options: { token: string; botUserId?: string },
) {
  let resources: Awaited<ReturnType<typeof getGuildPermissionResources>> | null = null;
  if (options.botUserId) {
    try {
      resources = await getGuildPermissionResources(
        config.guildId,
        options.botUserId,
        options.token,
      );
    } catch {
      resources = null;
    }
  }
  const context =
    resources && options.botUserId
      ? { guildId: config.guildId, botUserId: options.botUserId, ...resources }
      : null;
  const forum = resources?.channels.find((channel) => channel.id === config.forumChannelId);
  const panel = resources?.channels.find((channel) => channel.id === config.panelChannelId);
  const queue = resources?.channels.find((channel) => channel.id === config.modQueueChannelId);
  const digest = resources?.channels.find((channel) => channel.id === config.digestChannelId);
  const can = (channel: NonNullable<typeof forum> | undefined, permissions: bigint[]) =>
    Boolean(
      context &&
      channel &&
      permissions.every((permission) =>
        hasPermission(getChannelPermissions(context, channel), permission),
      ),
    );
  const checks = {
    configured: Boolean(config.forumChannelId && config.panelChannelId),
    forumResourceHealthy:
      forum?.type === 15 &&
      can(forum, [
        DISCORD_PERMISSION_FLAGS.viewChannel,
        DISCORD_PERMISSION_FLAGS.sendMessages,
        DISCORD_PERMISSION_FLAGS.createPublicThreads,
        DISCORD_PERMISSION_FLAGS.sendMessagesInThreads,
        DISCORD_PERMISSION_FLAGS.manageThreads,
        DISCORD_PERMISSION_FLAGS.manageWebhooks,
      ]),
    panelResourceHealthy:
      Boolean(panel && (panel.type === 0 || panel.type === 5)) &&
      can(panel, [DISCORD_PERMISSION_FLAGS.viewChannel, DISCORD_PERMISSION_FLAGS.sendMessages]),
    panelPublished: Boolean(config.panelMessageId),
    statusTagsHealthy: SUGGESTION_STATUSES.every((status) => Boolean(config.statusTagIds[status])),
    webhookAvailable: Boolean(config.replyWebhookId && config.replyWebhookCredentialId),
    modQueueAvailable:
      Boolean(queue && (queue.type === 0 || queue.type === 5)) &&
      can(queue, [DISCORD_PERMISSION_FLAGS.viewChannel, DISCORD_PERMISSION_FLAGS.sendMessages]),
    digestReady:
      !config.digestEnabled ||
      (Boolean(digest && (digest.type === 0 || digest.type === 5)) &&
        can(digest, [DISCORD_PERMISSION_FLAGS.viewChannel, DISCORD_PERMISSION_FLAGS.sendMessages])),
  };
  const healthy = Object.values(checks).every(Boolean);
  return {
    state: !checks.configured
      ? "not_configured"
      : !healthy
        ? "degraded"
        : config.enabled
          ? "ready"
          : "ready_disabled",
    checks,
  };
}

async function actor(
  reader: ((request: Request) => Promise<CustomerSession | null>) | undefined,
  request: Request,
): Promise<string> {
  const session = await reader?.(request);
  return session?.user.discordUserId ?? session?.user.id ?? "admin-ui";
}

function unavailable(): Response {
  return Response.json({ error: "Suggestions service unavailable" }, { status: 503 });
}

function publicConfig(config: Awaited<ReturnType<SuggestionService["getConfig"]>>) {
  return config;
}
