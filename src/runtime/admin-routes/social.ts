import type { Cache } from "../discord-json-cache";
import { defineRoute, type Route } from "../admin-route-registry";
import { type AdminAccess } from "../admin-access";
import { type RuntimeStores } from "../app-types";
import type { ServiceFactory } from "../service-factory";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import {
  createDefaultMarketplaceConfig,
  DEFAULT_MARKETPLACE_NOTICE_EMBED,
} from "../../marketplace-config";
import {
  guildScopedAccess,
  bodyGuildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import { z } from "zod";
import { bindAdminContract } from "../admin-contract-route";
import {
  getGuildAdminRole,
  getProductAnalyticsPreference,
  saveGuildAdminRole,
  saveProductAnalyticsPreference,
  createDashboardProductAnalyticsEvent,
} from "../../contracts/admin/cross-cutting";
import {
  browserPrivacySignalEnabled,
  createInsertionId,
  type ProductAnalyticsReporter,
} from "../../product-analytics";
import type { WebhookIngressGuardNamespace } from "../contracts/webhook-ingress-guard";

const DISCORD_ROLE_ID_PATTERN = /^\d{1,32}$/;
const SERVER_OPTION_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
const COUNTER_FORMAT_PLACEHOLDER = /{count}/g;
const LFG_COUNTER_FORMAT_LIMIT = 100;
const LFG_COUNTER_FORMAT_DEFAULT = "LFG ({count})";
const SERVER_OPTIONS_MIN = 1;
const SERVER_OPTIONS_MAX = 25;
const MARKETPLACE_ADDITIONAL_CHOICES_MAX = 10;
const LFG_EXPIRY_DURATION_HOURS_MIN = 1;
const LFG_EXPIRY_DURATION_HOURS_MAX = 168;
const LFG_EXPIRY_DURATION_HOURS_DEFAULT = 24;

const requiredGuildId = z.string().min(1, "Missing guildId");
const requiredPostId = z.string().min(1, "Missing postId");
const requiredClosedByUserId = z.string().min(1, "Missing closedByUserId");
const requiredChannelId = z.string().min(1, "Missing channelId");
const optionalNullableString = z.string().nullable().optional();
const optionalLabelField = z.string().trim().min(1, "Missing label");
const optionalServerOptionIdField = z
  .string()
  .trim()
  .min(1, "Missing id")
  .regex(SERVER_OPTION_ID_PATTERN, "Invalid id");

const guildIdQuerySchema = z.object({
  guildId: requiredGuildId.optional(),
  workspaceId: z.string().min(1).optional(),
});

const publishBodySchema = z.object({
  guildId: requiredGuildId,
  channelId: requiredChannelId,
});

const serverOptionSchema = z.object({
  id: optionalServerOptionIdField,
  label: optionalLabelField,
  emoji: optionalNullableString,
});

const serverOptionsArraySchema = z
  .array(serverOptionSchema)
  .min(SERVER_OPTIONS_MIN, "Add between 1 and 25 servers")
  .max(SERVER_OPTIONS_MAX, "Add between 1 and 25 servers")
  .superRefine((options, ctx) => {
    const seenIds = new Set<string>();
    options.forEach((option, index) => {
      if (seenIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: `Duplicate serverOptions[${index}].id`,
        });
      }
      seenIds.add(option.id);
    });
  });

const marketplaceNoticeEmbedSchema = z.object({
  title: z.string().trim().min(1, "Missing embed title").max(256),
  description: z.string().trim().min(1, "Missing embed description").max(4096),
  color: z.coerce.number().int().min(0).max(0xffffff),
  buttonLabel: z.string().trim().min(1, "Missing button label").max(80),
  buttonEmoji: optionalNullableString,
});

const marketplaceAdditionalChoiceSchema = z
  .object({
    id: optionalServerOptionIdField,
    label: z.string().trim().min(1, "Missing choice label").max(100),
    options: z.array(serverOptionSchema).min(2, "Add between 2 and 25 options").max(25),
  })
  .superRefine((choice, ctx) => {
    const ids = new Set<string>();
    choice.options.forEach((option, index) => {
      if (ids.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "id"],
          message: `Duplicate options[${index}].id`,
        });
      }
      ids.add(option.id);
    });
  });

const marketplaceClosePostSchema = z.object({
  guildId: requiredGuildId,
  postId: requiredPostId,
  closedByUserId: requiredClosedByUserId,
});

const marketplaceConfigSchema = z
  .object({
    guildId: requiredGuildId,
    workspaceId: z.string().min(1).optional(),
    noticeChannelId: optionalNullableString,
    noticeMessageId: optionalNullableString,
    logChannelId: optionalNullableString,
    noticeEmbed: marketplaceNoticeEmbedSchema.default(DEFAULT_MARKETPLACE_NOTICE_EMBED),
    serverChoiceEnabled: z.boolean().default(true),
    serverOptions: z.array(serverOptionSchema).max(SERVER_OPTIONS_MAX),
    additionalChoicesEnabled: z.boolean().default(false),
    additionalChoices: z
      .array(marketplaceAdditionalChoiceSchema)
      .max(MARKETPLACE_ADDITIONAL_CHOICES_MAX)
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (value.serverChoiceEnabled && value.serverOptions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverOptions"],
        message: "Add at least one server or disable server choice",
      });
    }
    if (value.additionalChoicesEnabled && value.additionalChoices.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["additionalChoices"],
        message: "Add at least one additional choice or disable additional choices",
      });
    }
    for (const [field, entries] of [
      ["serverOptions", value.serverOptions],
      ["additionalChoices", value.additionalChoices],
    ] as const) {
      const ids = new Set<string>();
      entries.forEach((entry, index) => {
        if (ids.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, "id"],
            message: `Duplicate ${field}[${index}].id`,
          });
        }
        ids.add(entry.id);
      });
    }
  });

const lfgCounterDisplayFormatSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return LFG_COUNTER_FORMAT_DEFAULT;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : LFG_COUNTER_FORMAT_DEFAULT;
  });

const lfgConfigSchema = z
  .object({
    guildId: requiredGuildId,
    noticeChannelId: optionalNullableString,
    noticeMessageId: optionalNullableString,
    notificationRoleId: optionalNullableString,
    noticeColor: z.number().int().min(0).max(0xffffff).default(0x2b2d31),
    counterVoiceChannelId: optionalNullableString,
    counterDisplayFormat: lfgCounterDisplayFormatSchema,
    approvalFlowEnabled: z.boolean().default(false),
    approvalAuditChannelId: optionalNullableString,
    approvalVoiceCategoryId: optionalNullableString,
    expiryAction: z.enum(["close", "delete", "nothing"]).default("close"),
    expiryDurationHours: z.coerce
      .number()
      .min(LFG_EXPIRY_DURATION_HOURS_MIN, "expiryDurationHours must be between 1 and 168")
      .max(LFG_EXPIRY_DURATION_HOURS_MAX, "expiryDurationHours must be between 1 and 168")
      .default(LFG_EXPIRY_DURATION_HOURS_DEFAULT),
    serverOptions: serverOptionsArraySchema,
  })
  .superRefine((value, ctx) => {
    const worstCase = value.counterDisplayFormat.replace(COUNTER_FORMAT_PLACEHOLDER, "999");
    if (worstCase.length > LFG_COUNTER_FORMAT_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counterDisplayFormat"],
        message: `counterDisplayFormat may exceed Discord's 100-character channel name limit (worst case: ${worstCase.length} chars).`,
      });
    }
  });

const lfgClosePostSchema = z.object({
  guildId: requiredGuildId,
  postId: requiredPostId,
  closedByUserId: requiredClosedByUserId,
});

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAdminRoleId(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) return null;
  if (!DISCORD_ROLE_ID_PATTERN.test(normalized)) {
    throw new Error("adminRoleId must be a Discord role ID");
  }
  return normalized;
}

function defaultLfgConfig(guildId: string) {
  return {
    guildId,
    noticeChannelId: null,
    noticeMessageId: null,
    notificationRoleId: null,
    noticeColor: 0x2b2d31,
    counterVoiceChannelId: null,
    counterDisplayFormat: LFG_COUNTER_FORMAT_DEFAULT,
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close" as const,
    expiryDurationHours: LFG_EXPIRY_DURATION_HOURS_DEFAULT,
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: "🧊" },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
      { id: "both", label: "Both", emoji: "🔁" },
    ],
    updatedAtMs: Date.now(),
  };
}

export interface SocialAdminRoutesOptions {
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  services: Pick<ServiceFactory, "lfgService" | "marketplaceService">;
  discordBotToken: string;
  guildResources?: GuildResourceValidator;
  discordCache?: Cache<string>;
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
  webhookIngressGuard?: WebhookIngressGuardNamespace;
}

export function createSocialAdminRoutes(
  options: SocialAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  const { stores, services, discordBotToken } = options;
  const analyticsPreferences = stores.productAnalyticsPreferences;
  const guildResources =
    options.guildResources ?? createDiscordGuildResourceValidator(discordBotToken);
  return [
    defineRoute({
      ...bindAdminContract(getGuildAdminRole),
      method: "GET",
      path: "/admin/api/guild-rbac/admin-role",
      access: guildScopedAccess("read"),
      handler: async ({ query, request }) => {
        const guildId = requireGuildQueryId(query);
        const [delegation, policy] = await Promise.all([
          options.adminAccess.authorize(request, {
            mode: "write",
            guildId,
            guildCapability: "manage-delegation",
          }),
          options.adminAccess.authorize(request, {
            mode: "write",
            guildId,
            guildCapability: "manage-server-policy",
          }),
        ]);
        return Response.json({
          guildId,
          adminRoleId: await stores.guildRbac.readGuildAdminRoleId(guildId),
          manageServerAdminEnabled: await stores.guildRbac.readManageServerAdminEnabled(guildId),
          canManageDelegation: delegation.ok,
          canManageServerPolicy: policy.ok,
        });
      },
    }),
    defineRoute({
      ...bindAdminContract(getProductAnalyticsPreference),
      method: "GET",
      path: "/admin/api/product-analytics/preference",
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        return Response.json({
          guildId,
          enabled: analyticsPreferences ? await analyticsPreferences.readEnabled(guildId) : true,
        });
      },
    }),
    defineRoute({
      ...bindAdminContract(saveProductAnalyticsPreference),
      method: "POST",
      path: "/admin/api/product-analytics/preference",
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        await analyticsPreferences?.setEnabled(body.guildId, body.enabled, Date.now());
        return Response.json({ guildId: body.guildId, enabled: body.enabled });
      },
    }),
    defineRoute({
      ...bindAdminContract(createDashboardProductAnalyticsEvent),
      method: "POST",
      path: "/admin/api/product-analytics/events",
      maxBodyBytes: 1_024,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const guard = options.webhookIngressGuard?.getByName(
          `product-analytics:v1:guild:${body.guildId}`,
        );
        let leaseId: string | undefined;
        if (guard) {
          try {
            const admission = await guard.reserve({
              nowMs: Date.now(),
              policy: {
                requestsPerMinute: 30,
                burst: 10,
                concurrency: 5,
                leaseTimeoutMs: 5_000,
                duplicateWindowMs: 0,
              },
            });
            if (!admission.ok) return Response.json({ accepted: true }, { status: 202 });
            leaseId = admission.leaseId;
          } catch {
            return Response.json({ accepted: true }, { status: 202 });
          }
        }
        if (options.productAnalytics && !browserPrivacySignalEnabled(request)) {
          const event =
            body.event === "page_viewed"
              ? {
                  name: "dashboard_page_viewed" as const,
                  insertionId: createInsertionId(),
                  guildId: body.guildId,
                  page: body.page,
                  feature: body.feature,
                }
              : {
                  name: "dashboard_milestone" as const,
                  insertionId: createInsertionId(),
                  guildId: body.guildId,
                  action: body.action,
                  feature: body.feature,
                  status: body.status,
                  reasonCode: body.reasonCode,
                };
          const delivery = options.productAnalytics.report(event).catch(() => undefined);
          options.waitUntil?.(delivery);
        }
        if (guard && leaseId) {
          const completion = guard
            .complete({ leaseId, outcome: "accepted", nowMs: Date.now() })
            .catch(() => undefined);
          if (options.waitUntil) options.waitUntil(completion);
        }
        return Response.json({ accepted: true }, { status: 202 });
      },
    }),
    defineRoute({
      ...bindAdminContract(saveGuildAdminRole),
      method: "POST",
      path: "/admin/api/guild-rbac/admin-role",
      access: ({ body }) => {
        const input = body as { guildId: string; manageServerAdminEnabled?: boolean };
        return {
          mode: "write",
          guildId: input.guildId,
          guildCapability:
            input.manageServerAdminEnabled !== undefined
              ? "manage-server-policy"
              : "manage-delegation",
        };
      },
      handler: async ({ body }) => {
        if (body.adminRoleId !== undefined) {
          const adminRoleId = normalizeAdminRoleId(body.adminRoleId);
          if (adminRoleId) {
            if (adminRoleId === body.guildId)
              return Response.json(
                { error: "Choose a role other than @everyone." },
                { status: 400 },
              );
            await guildResources.requireRole(body.guildId, adminRoleId);
          }
          await stores.guildRbac.upsertGuildAdminRoleId(body.guildId, adminRoleId);
        }
        if (body.manageServerAdminEnabled !== undefined)
          await stores.guildRbac.setManageServerAdminEnabled(
            body.guildId,
            body.manageServerAdminEnabled,
          );
        return Response.json({
          guildId: body.guildId,
          adminRoleId: await stores.guildRbac.readGuildAdminRoleId(body.guildId),
          manageServerAdminEnabled: await stores.guildRbac.readManageServerAdminEnabled(
            body.guildId,
          ),
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/marketplace",
      feature: "marketplace",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, posts, logs] = await Promise.all([
          stores.marketplace.readMarketplaceConfig(guildId),
          stores.marketplace.listMarketplacePosts(guildId, { limit: 50 }),
          stores.marketplace.listMarketplaceLogs(guildId, 20),
        ]);

        return Response.json({
          guildId,
          config: config ?? createDefaultMarketplaceConfig(guildId),
          posts,
          logs,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/marketplace/config",
      feature: "marketplace",
      body: marketplaceConfigSchema,
      access: ({ body }) => {
        const parsedBody = body as { guildId: string; workspaceId?: string };
        return parsedBody.workspaceId
          ? { mode: "write", guildId: parsedBody.guildId, workspaceId: parsedBody.workspaceId }
          : { mode: "write", guildId: parsedBody.guildId };
      },
      handler: async ({ body }) => {
        const noticeEmbed = body.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED;
        const additionalChoices = body.additionalChoices ?? [];
        const now = Date.now();
        const config = {
          guildId: body.guildId,
          noticeChannelId: normalizeOptionalString(body.noticeChannelId),
          noticeMessageId: normalizeOptionalString(body.noticeMessageId),
          logChannelId: normalizeOptionalString(body.logChannelId),
          noticeEmbed: {
            ...noticeEmbed,
            buttonEmoji: normalizeOptionalString(noticeEmbed.buttonEmoji),
          },
          serverChoiceEnabled: body.serverChoiceEnabled,
          serverOptions: body.serverOptions.map((option) => ({
            id: option.id,
            label: option.label,
            emoji: normalizeOptionalString(option.emoji),
          })),
          additionalChoicesEnabled: body.additionalChoicesEnabled,
          additionalChoices: additionalChoices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            options: choice.options.map((option) => ({
              id: option.id,
              label: option.label,
              emoji: normalizeOptionalString(option.emoji),
            })),
          })),
          flowUpdatedAtMs: now,
          updatedAtMs: now,
        };
        const saved = await services.marketplaceService.updateConfig(config);
        return Response.json(saved);
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/marketplace/disable",
      feature: "marketplace",
      body: z.object({ guildId: requiredGuildId }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) =>
        Response.json(await services.marketplaceService.disable(body.guildId)),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/marketplace/post/close",
      feature: "marketplace",
      body: marketplaceClosePostSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) =>
        Response.json(
          await stores.marketplace.closeMarketplacePost({
            guildId: body.guildId,
            postId: body.postId,
            closedByUserId: body.closedByUserId,
            closedAtMs: Date.now(),
          }),
        ),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/marketplace/publish",
      feature: "marketplace",
      body: publishBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const config = await stores.marketplace.readMarketplaceConfig(body.guildId);
        if (!config) return Response.json({ error: "Not found" }, { status: 404 });
        await services.marketplaceService.setupNotice(body.guildId, body.channelId);
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/lfg",
      feature: "lfg",
      query: guildIdQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, posts] = await Promise.all([
          stores.lfg.readLfgConfig(guildId),
          stores.lfg.listLfgPosts(guildId, { limit: 50 }),
        ]);

        return Response.json({ guildId, config: config ?? defaultLfgConfig(guildId), posts });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/lfg/config",
      feature: "lfg",
      body: lfgConfigSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const lfgService = services.lfgService;
        await lfgService.updateConfig({
          guildId: body.guildId,
          noticeChannelId: normalizeOptionalString(body.noticeChannelId),
          noticeMessageId: normalizeOptionalString(body.noticeMessageId),
          notificationRoleId: normalizeOptionalString(body.notificationRoleId),
          noticeColor: body.noticeColor,
          counterVoiceChannelId: normalizeOptionalString(body.counterVoiceChannelId),
          counterDisplayFormat: body.counterDisplayFormat ?? LFG_COUNTER_FORMAT_DEFAULT,
          approvalFlowEnabled: body.approvalFlowEnabled ?? false,
          approvalAuditChannelId: normalizeOptionalString(body.approvalAuditChannelId),
          approvalVoiceCategoryId: normalizeOptionalString(body.approvalVoiceCategoryId),
          expiryAction: body.expiryAction ?? "close",
          expiryDurationHours: body.expiryDurationHours ?? LFG_EXPIRY_DURATION_HOURS_DEFAULT,
          serverOptions: body.serverOptions.map((option) => ({
            id: option.id,
            label: option.label,
            emoji: normalizeOptionalString(option.emoji),
          })),
          updatedAtMs: Date.now(),
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/lfg/disable",
      feature: "lfg",
      body: z.object({ guildId: requiredGuildId }),
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => Response.json(await services.lfgService.disable(body.guildId)),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/lfg/post/close",
      feature: "lfg",
      body: lfgClosePostSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const lfgService = services.lfgService;
        return Response.json(
          await lfgService.closePost({
            guildId: body.guildId,
            postId: body.postId,
            closedByUserId: body.closedByUserId,
          }),
        );
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/lfg/publish",
      feature: "lfg",
      body: publishBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const config = await stores.lfg.readLfgConfig(body.guildId);
        if (!config) return Response.json({ error: "Not found" }, { status: 404 });
        await services.lfgService.setupNotice(body.guildId, body.channelId);
        return Response.json({ ok: true });
      },
    }),
  ];
}
