import { defineRoute, type Route } from "../admin-route-registry";
import { type AdminAccess } from "../admin-access";
import type { RuntimeStores } from "../app-types";
import {
  BOT_DEFENSE_HONEYPOT_CHANNEL_TOPIC,
  configureBotDefenseHoneypotChannel,
} from "../../discord";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import {
  MemberVerificationService,
  type ManualWelcomeDmResult,
} from "../../services/member-verification-service";
import { FeatureSetupRunner } from "../../services/feature-setup-runner";
import type { FeatureSetupDefinition } from "../../feature-setup";
import {
  getBotDefenseHoneypotChannelLimitError,
  MAX_BOT_DEFENSE_HONEYPOT_CHANNELS,
} from "../../bot-defense-config";
import {
  getGuildEntitlementLimits,
  type BotDefenseConfig,
  type ChannelFilterMode,
  type EvidenceFieldDefinition,
  type EvidenceVaultRecord,
  type MentionProtectionConfig,
} from "../../types";
import {
  guildScopedAccess,
  bodyGuildScopedAccess,
  requireGuildQueryId,
} from "../admin-route-guards";
import { getCachedGuildTicketResources } from "../admin-discord-cache";
import { bindAdminContract } from "../admin-contract-route";
import { getEntitlement } from "../../contracts/admin/cross-cutting";
import { z } from "zod";
import type { CustomerSession } from "../auth/customer-session";
import type { ConfigurationActorContext } from "../../configuration-revisions";
import {
  botDefenseRevisionAdapter,
  mentionProtectionRevisionAdapter,
} from "../../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../../configuration-revisions/coordinator";

const reactionLimitsQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

const reactionLimitConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  limitsEnabled: z.boolean({ error: () => "Missing limitsEnabled" }),
  maxReactionsPerMessage: z.number().int().positive().nullable().optional(),
  maxReactionsPerUserPerMessage: z.number().int().positive().nullable().optional(),
  breachThreshold: z.number().int().positive().nullable().optional(),
  breachRoleId: z.string().nullable().optional(),
  breachRoleDurationMs: z.number().int().positive().nullable().optional(),
  breachDmText: z.string().nullable().optional(),
  channelMode: z.enum(["include", "exclude"]).optional(),
  channelIds: z.array(z.string()).optional(),
});

const reactionLimitCounterClearBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  userId: z.string().nullable().optional(),
});

const evidenceFieldDefinitionSchema = z.object({
  key: z.string().min(1).optional(),
  label: z.string().min(1),
  type: z.enum(["text", "short_text", "enum"]),
  allowedValues: z.array(z.string().min(1)).optional(),
});

const evidenceVaultConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  auditChannelId: z.string().min(1, "Missing auditChannelId"),
  accessRoleIds: z.array(z.string().min(1)).optional(),
  subjectsEnabled: z.boolean().optional(),
  evidenceFields: z.array(evidenceFieldDefinitionSchema).max(5).optional(),
});

const memberVerificationConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  enabled: z.boolean(),
  verifiedRoleId: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).max(4096).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  imageUrl: z.string().url().nullable().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  rulesUrl: z.string().url().nullable().optional(),
  verifyButtonEmoji: z.string().max(256).nullable().optional(),
  deliveryMode: z.enum(["dm", "channel"]).optional(),
  verificationMethod: z.enum(["discord-button", "turnstile", "steam-link"]).optional(),
  welcomeChannelId: z.string().min(1).nullable().optional(),
});

const memberVerificationPanelPublishBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
});

const imageRulesConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  enabled: z.boolean(),
  topicDescription: z.string().optional(),
  autoDeleteThreshold: z.number().min(0).max(1).optional(),
  modReviewThreshold: z.number().min(0).max(1).optional(),
  targetChannelIds: z.array(z.string().min(1)).optional(),
  excludedRoleIds: z.array(z.string().min(1)).optional(),
  modQueueChannelId: z.string().nullable().optional(),
  modRoleIds: z.array(z.string().min(1)).optional(),
  pingOnQueuePost: z.boolean().optional(),
  reactOnTopic: z.boolean().optional(),
  auditOnTopic: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

const botDefenseConfigBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  honeypotEnabled: z.boolean(),
  honeypotWarnUser: z.boolean().optional(),
  honeypotDeleteMessage: z.boolean().optional(),
  rateEnabled: z.boolean(),
  rateWarnUser: z.boolean().optional(),
  rateDeleteMessage: z.boolean().optional(),
  honeypotChannelIds: z
    .array(z.string().min(1))
    .max(
      MAX_BOT_DEFENSE_HONEYPOT_CHANNELS,
      `Choose no more than ${MAX_BOT_DEFENSE_HONEYPOT_CHANNELS} honeypot channels.`,
    )
    .optional(),
  rateChannelThreshold: z.number().int().positive().optional(),
  rateWindowSeconds: z.number().int().positive().optional(),
  excludedRoleIds: z.array(z.string().min(1)).optional(),
  modRoleIds: z.array(z.string().min(1)).optional(),
  modQueueChannelId: z.string().nullable().optional(),
  pingOnQueuePost: z.boolean().optional(),
});

const botDefenseHoneypotChannelBodySchema = z.object({
  guildId: z.string().min(1, "Missing guildId"),
  excludedRoleIds: z.array(z.string().min(1)).optional(),
});

function defaultBotDefenseConfig(guildId: string, nowMs: number): BotDefenseConfig {
  return {
    guildId,
    honeypotEnabled: false,
    honeypotWarnUser: false,
    honeypotDeleteMessage: false,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: [],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: [],
    modQueueChannelId: null,
    pingOnQueuePost: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

const mentionProtectionRestrictionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("timeout"),
    durationMs: z
      .number()
      .int()
      .min(60_000)
      .max(28 * 24 * 60 * 60 * 1_000),
  }),
  z.object({
    type: z.literal("timed-role"),
    roleId: z.string().min(1),
    durationMs: z.number().int().min(60_000),
  }),
]);

const mentionProtectionPolicySchema = z.object({
  reply: z.boolean(),
  delete: z.boolean(),
  restriction: mentionProtectionRestrictionSchema,
});

const mentionProtectionConfigBodySchema = z
  .object({
    guildId: z.string().min(1, "Missing guildId"),
    adminEnabled: z.boolean(),
    spamEnabled: z.boolean(),
    protectedAdminRoleIds: z.array(z.string().min(1)),
    channelMode: z.enum(["include", "exclude"]),
    channelIds: z.array(z.string().min(1)),
    excludedRoleIds: z.array(z.string().min(1)),
    massMentionThreshold: z.number().int().min(2).max(50),
    burstMessageThreshold: z.number().int().min(2).max(20),
    burstWindowSeconds: z.number().int().min(5).max(300),
    adminRepeatPeriodMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1_000),
    spamRepeatPeriodMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1_000),
    adminInitialResponse: mentionProtectionPolicySchema,
    adminRepeatResponse: mentionProtectionPolicySchema,
    spamInitialResponse: mentionProtectionPolicySchema,
    spamRepeatResponse: mentionProtectionPolicySchema,
  })
  .superRefine((config, context) => {
    if (config.adminEnabled && config.protectedAdminRoleIds.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protectedAdminRoleIds"],
        message: "Admin Mention Protection requires at least one Protected Admin Role.",
      });
    }
    for (const [enabled, path, policy] of [
      [config.adminEnabled, "adminInitialResponse", config.adminInitialResponse],
      [config.adminEnabled, "adminRepeatResponse", config.adminRepeatResponse],
      [config.spamEnabled, "spamInitialResponse", config.spamInitialResponse],
      [config.spamEnabled, "spamRepeatResponse", config.spamRepeatResponse],
    ] as const) {
      if (enabled && !policy.reply && !policy.delete && policy.restriction.type === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "An enabled protection's Response Policy must select at least one action.",
        });
      }
    }
  });

function mentionProtectionRoleIds(
  config: z.infer<typeof mentionProtectionConfigBodySchema>,
  includePaidRestrictions = true,
): Set<string> {
  const roleIds = new Set([...config.protectedAdminRoleIds, ...config.excludedRoleIds]);
  for (const policy of [
    config.adminInitialResponse,
    config.adminRepeatResponse,
    config.spamInitialResponse,
    config.spamRepeatResponse,
  ]) {
    if (includePaidRestrictions && policy.restriction.type === "timed-role") {
      roleIds.add(policy.restriction.roleId);
    }
  }
  return roleIds;
}

function findChangedPaidBotDefenseControl(
  body: z.infer<typeof botDefenseConfigBodySchema>,
  existing: BotDefenseConfig | null,
): string | null {
  const requestedRate = {
    enabled: body.rateEnabled,
    warnUser: body.rateWarnUser ?? false,
    deleteMessage: body.rateDeleteMessage ?? false,
    channelThreshold: body.rateChannelThreshold ?? 5,
    windowSeconds: body.rateWindowSeconds ?? 60,
  };
  const savedRate = existing
    ? {
        enabled: existing.rateEnabled,
        warnUser: existing.rateWarnUser,
        deleteMessage: existing.rateDeleteMessage,
        channelThreshold: existing.rateChannelThreshold,
        windowSeconds: existing.rateWindowSeconds,
      }
    : {
        enabled: false,
        warnUser: false,
        deleteMessage: false,
        channelThreshold: 5,
        windowSeconds: 60,
      };
  return JSON.stringify(requestedRate) === JSON.stringify(savedRate) ? null : "Rate Detector";
}

function findChangedPaidMentionProtectionControl(
  body: z.infer<typeof mentionProtectionConfigBodySchema>,
  existing: MentionProtectionConfig | null,
): string | null {
  if (existing) {
    const requestedSpam = {
      enabled: body.spamEnabled,
      massMentionThreshold: body.massMentionThreshold,
      burstMessageThreshold: body.burstMessageThreshold,
      burstWindowSeconds: body.burstWindowSeconds,
      repeatPeriodMs: body.spamRepeatPeriodMs,
      initialResponse: body.spamInitialResponse,
      repeatResponse: body.spamRepeatResponse,
    };
    const savedSpam = {
      enabled: existing.spamEnabled,
      massMentionThreshold: existing.massMentionThreshold,
      burstMessageThreshold: existing.burstMessageThreshold,
      burstWindowSeconds: existing.burstWindowSeconds,
      repeatPeriodMs: existing.spamRepeatPeriodMs,
      initialResponse: existing.spamInitialResponse,
      repeatResponse: existing.spamRepeatResponse,
    };
    if (JSON.stringify(requestedSpam) !== JSON.stringify(savedSpam)) {
      return "Mention Spam Protection";
    }
  } else if (body.spamEnabled) {
    return "Mention Spam Protection";
  }

  for (const [requested, saved] of [
    [body.adminInitialResponse.restriction, existing?.adminInitialResponse.restriction],
    [body.adminRepeatResponse.restriction, existing?.adminRepeatResponse.restriction],
  ] as const) {
    const savedRestriction = saved ?? { type: "none" };
    if (JSON.stringify(requested) !== JSON.stringify(savedRestriction)) {
      return "Mention Protection member restrictions";
    }
  }
  return null;
}

function paidCapabilityResponse(capability: string): Response {
  return Response.json({ error: `${capability} requires a paid plan.` }, { status: 402 });
}

export interface GuildFeaturesAdminRoutesOptions {
  stores: RuntimeStores;
  adminAccess: AdminAccess;
  discordBotToken: string;
  discordBotUserId?: string;
  discordSupportInvite?: string;
  guildResources?: GuildResourceValidator;
  memberVerificationService?: MemberVerificationService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}

export function createGuildFeaturesAdminRoutes(
  options: GuildFeaturesAdminRoutesOptions,
): Array<Route<any, any, Response>> {
  const guildResources =
    options.guildResources ?? createDiscordGuildResourceValidator(options.discordBotToken);
  const requireMemberVerification = (): MemberVerificationService => {
    if (!options.memberVerificationService) {
      throw new Error("Member Verification module is unavailable.");
    }
    return options.memberVerificationService;
  };
  return [
    defineRoute({
      method: "POST",
      path: "/admin/api/evidence-vault/enabled",
      body: z.object({ guildId: z.string().min(1), enabled: z.boolean() }),
      access: bodyGuildScopedAccess("write"),
      feature: "evidenceVault",
      handler: async ({ body }) => {
        const config = await options.stores.evidenceVault.readConfig(body.guildId);
        if (!config) return Response.json({ error: "Configuration not found." }, { status: 404 });
        if (!(await options.stores.evidenceVault.setEnabled(body.guildId, body.enabled)))
          return Response.json({ error: "Configuration not found." }, { status: 404 });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      ...bindAdminContract(getEntitlement),
      method: "GET",
      path: "/admin/api/entitlement",
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const entitlement = await options.stores.guildEntitlements.readGuildEntitlement(guildId);
        const limits = getGuildEntitlementLimits(entitlement.tier);
        const usage = await readGuildR2Usage(options.stores.guildR2Objects, guildId);
        return Response.json({
          tier: entitlement.tier,
          limits,
          supportInvite: options.discordSupportInvite ?? null,
          r2Usage: {
            ...usage,
            maxBytes: limits.r2MaxBytes,
          },
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/reaction-limits",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, counters] = await Promise.all([
          options.stores.reactionLimits.readReactionLimitConfig(guildId),
          options.stores.reactionLimits.readBreachCounters(guildId),
        ]);
        return Response.json({ guildId, config, counters });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/reaction-limits/config",
      body: reactionLimitConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        const resources = await guildResources.forGuild(body.guildId);
        if (body.breachRoleId) resources.requireRole(body.breachRoleId);
        resources.requireChannels(body.channelIds ?? []);
        const channelMode: ChannelFilterMode = body.channelMode ?? "include";
        await options.stores.reactionLimits.upsertReactionLimitConfig({
          guildId: body.guildId,
          limitsEnabled: body.limitsEnabled,
          maxReactionsPerMessage: body.maxReactionsPerMessage ?? null,
          maxReactionsPerUserPerMessage: body.maxReactionsPerUserPerMessage ?? null,
          breachThreshold: body.breachThreshold ?? null,
          breachRoleId: body.breachRoleId ?? null,
          breachRoleDurationMs: body.breachRoleDurationMs ?? null,
          breachDmText: body.breachDmText ?? null,
          channelMode,
          channelIds: body.channelIds ?? [],
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/reaction-limits/counter/clear",
      body: reactionLimitCounterClearBodySchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body }) => {
        if (body.userId) {
          await options.stores.reactionLimits.resetBreachCounter(body.guildId, body.userId);
        } else {
          await options.stores.reactionLimits.resetAllBreachCounters(body.guildId);
        }
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/evidence-vault",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      feature: "evidenceVault",
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const [config, records, entitlement] = await Promise.all([
          options.stores.evidenceVault.readConfig(guildId),
          options.stores.evidenceVault.listRecords(guildId),
          options.stores.guildEntitlements.readGuildEntitlement(guildId),
        ]);
        const enumValueUsage = config
          ? buildEvidenceFieldEnumValueUsage(config.evidenceFields ?? [], records)
          : {};
        return Response.json({
          guildId,
          config,
          enumValueUsage,
          recordUsage: {
            used: records.length,
            max: getGuildEntitlementLimits(entitlement.tier).evidenceVaultMaxRecords,
          },
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/evidence-vault/config",
      body: evidenceVaultConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "evidenceVault",
      handler: async ({ body }) => {
        const resources = await guildResources.forGuild(body.guildId);
        resources.requireTextChannel(body.auditChannelId);
        resources.requireRoles(body.accessRoleIds ?? []);
        const usedFieldKeys = new Set<string>();
        const previous = await options.stores.evidenceVault.readConfig(body.guildId);
        const config = {
          guildId: body.guildId,
          ...(previous?.enabled === false ? { enabled: false } : {}),
          auditChannelId: body.auditChannelId,
          accessRoleIds: body.accessRoleIds ?? [],
          subjectsEnabled: body.subjectsEnabled === true,
          evidenceFields: (body.evidenceFields ?? []).map((field) => {
            const key = allocateEvidenceFieldKey(field.key, field.label, usedFieldKeys);
            return {
              key,
              label: field.label.trim(),
              type: field.type,
              ...(field.type === "enum"
                ? { allowedValues: normalizeEvidenceFieldAllowedValues(field.allowedValues ?? []) }
                : {}),
            };
          }),
          updatedAtMs: Date.now(),
        };
        const invalidEnum = config.evidenceFields.find(
          (field) => field.type === "enum" && (field.allowedValues ?? []).length === 0,
        );
        if (invalidEnum) {
          return Response.json(
            { error: "Enum Evidence Fields require at least one allowed value." },
            { status: 400 },
          );
        }
        await options.stores.evidenceVault.upsertConfig(config);
        return Response.json({ guildId: body.guildId, config });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/image-rules",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      feature: "imageRules",
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const config = await options.stores.imageRules.readConfig(guildId);
        return Response.json({ guildId, config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/image-rules/config",
      body: imageRulesConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      feature: "imageRules",
      handler: async ({ body }) => {
        const autoDeleteThreshold = body.autoDeleteThreshold ?? 0.85;
        const modReviewThreshold = body.modReviewThreshold ?? 0.65;
        const targetChannelIds = body.targetChannelIds ?? [];
        const excludedRoleIds = body.excludedRoleIds ?? [];
        const modRoleIds = body.modRoleIds ?? [];

        if (
          modReviewThreshold < 0 ||
          autoDeleteThreshold > 1 ||
          modReviewThreshold >= autoDeleteThreshold
        ) {
          return Response.json(
            {
              error: "Thresholds must satisfy 0 <= modReviewThreshold < autoDeleteThreshold <= 1.",
            },
            { status: 400 },
          );
        }

        if (body.enabled && targetChannelIds.length === 0) {
          return Response.json(
            { error: "At least one target channel is required when Image Rules is enabled." },
            { status: 400 },
          );
        }

        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        const channelIds = new Set(resources.channels.map((channel) => channel.id));
        const roleIds = new Set(resources.roles.map((role) => role.id));

        if (body.modQueueChannelId && !channelIds.has(body.modQueueChannelId)) {
          return Response.json(
            { error: "Mod Queue channel does not exist in this Guild." },
            { status: 400 },
          );
        }

        for (const channelId of targetChannelIds) {
          if (!channelIds.has(channelId)) {
            return Response.json(
              { error: `Target channel ${channelId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        for (const roleId of excludedRoleIds) {
          if (!roleIds.has(roleId)) {
            return Response.json(
              { error: `Excluded role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        for (const roleId of modRoleIds) {
          if (!roleIds.has(roleId)) {
            return Response.json(
              { error: `Mod role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        const nowMs = Date.now();
        const existing = await options.stores.imageRules.readConfig(body.guildId);
        const config = {
          guildId: body.guildId,
          enabled: body.enabled,
          topicDescription: body.topicDescription ?? "",
          autoDeleteThreshold,
          modReviewThreshold,
          targetChannelIds,
          excludedRoleIds,
          modQueueChannelId: body.modQueueChannelId ?? null,
          modRoleIds,
          pingOnQueuePost: body.pingOnQueuePost ?? true,
          reactOnTopic: body.reactOnTopic ?? false,
          auditOnTopic: body.auditOnTopic ?? false,
          dryRun: body.dryRun ?? false,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };
        await options.stores.imageRules.upsertConfig(config);
        return Response.json({ guildId: body.guildId, config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/image-rules/delete",
      body: z.object({ guildId: z.string().min(1, "Missing guildId") }),
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      feature: "imageRules",
      handler: async ({ body }) => {
        await options.stores.imageRules.deleteConfig(body.guildId);
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/bot-defense",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      feature: "botDefense",
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const config = await options.stores.botDefense.readConfig(guildId);
        return Response.json({ guildId, config });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/mention-protection",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      feature: "mentionProtection",
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        const config = await options.stores.mentionProtection.readConfig(guildId);
        return Response.json({ guildId, config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/mention-protection/config",
      body: mentionProtectionConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "mentionProtection",
      handler: async ({ body, request, adminRequest }) => {
        const existing = await options.stores.mentionProtection.readConfig(body.guildId);
        const entitlement = await options.stores.guildEntitlements.readGuildEntitlement(
          body.guildId,
        );
        const paidFeaturesAvailable = getGuildEntitlementLimits(entitlement.tier).paidFeatures;
        if (!paidFeaturesAvailable) {
          const paidControl = findChangedPaidMentionProtectionControl(body, existing);
          if (paidControl) return paidCapabilityResponse(paidControl);
          if (
            body.adminEnabled &&
            [body.adminInitialResponse, body.adminRepeatResponse].some(
              (policy) => !policy.reply && !policy.delete,
            )
          ) {
            return Response.json(
              { error: "Admin Mention Protection on Free must warn and/or delete." },
              { status: 400 },
            );
          }
        }
        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        const channelIds = new Set(resources.channels.map((channel) => channel.id));
        const roleIds = new Set(resources.roles.map((role) => role.id));
        for (const channelId of body.channelIds) {
          if (!channelIds.has(channelId)) {
            return Response.json(
              { error: `Mention Protection channel ${channelId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }
        for (const roleId of mentionProtectionRoleIds(body, paidFeaturesAvailable)) {
          if (!roleIds.has(roleId)) {
            return Response.json(
              { error: `Mention Protection role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        const nowMs = Date.now();
        const config = {
          ...body,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "mention-protection",
            resourceKey: "default",
            current: existing,
            next: config,
            adapter: mentionProtectionRevisionAdapter,
            actor: await configurationActor(options, request, adminRequest),
          },
          commitFree: () => options.stores.mentionProtection.upsertConfig(config),
        });
        return Response.json({ guildId: body.guildId, config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/mention-protection/delete",
      body: z.object({ guildId: z.string().min(1, "Missing guildId") }),
      access: bodyGuildScopedAccess("write"),
      feature: "mentionProtection",
      handler: async ({ body, request, adminRequest }) => {
        const existing = await options.stores.mentionProtection.readConfig(body.guildId);
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "mention-protection",
            resourceKey: "default",
            current: existing,
            next: null,
            adapter: mentionProtectionRevisionAdapter,
            actor: await configurationActor(options, request, adminRequest),
          },
          commitFree: () => options.stores.mentionProtection.deleteConfig(body.guildId),
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/bot-defense/honeypot-channel",
      body: botDefenseHoneypotChannelBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "botDefense",
      handler: async ({ body, request, adminRequest }) => {
        if (!options.discordBotUserId) {
          return Response.json(
            { error: "Bot user identity is unavailable for channel setup." },
            { status: 503 },
          );
        }

        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        const actor = await configurationActor(options, request, adminRequest);
        const rolesById = new Map(resources.roles.map((role) => [role.id, role]));
        const excludedRoleIds = body.excludedRoleIds ?? [];
        for (const roleId of excludedRoleIds) {
          if (!rolesById.has(roleId)) {
            return Response.json(
              { error: `Excluded role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        const hiddenRoleIds = excludedRoleIds.filter(
          (roleId) => rolesById.get(roleId)?.managed !== true,
        );
        const existingChannel = resources.channels.find(
          (channel) => channel.type === 0 && channel.topic === BOT_DEFENSE_HONEYPOT_CHANNEL_TOPIC,
        );
        const currentConfig = await options.stores.botDefense.readConfig(body.guildId);
        const setupChannelIds = [
          ...new Set([
            ...(currentConfig?.honeypotChannelIds ?? []),
            existingChannel?.id ?? "new-recommended-honeypot-channel",
          ]),
        ];
        const setupLimitError = getBotDefenseHoneypotChannelLimitError(setupChannelIds);
        if (setupLimitError) {
          return Response.json({ error: setupLimitError }, { status: 400 });
        }
        if (!options.stores.featureSetup) {
          const channel = await configureBotDefenseHoneypotChannel(
            {
              guildId: body.guildId,
              botUserId: options.discordBotUserId,
              hiddenRoleIds,
              channelId: existingChannel?.id,
            },
            options.discordBotToken,
          );
          return Response.json({ channel, created: !existingChannel });
        }

        const definition: FeatureSetupDefinition = {
          guildId: body.guildId,
          featureKey: "bot_defense_honeypot",
          version: 1,
          preflight: async () => {},
          dependencies: [
            {
              key: "honeypot_channel",
              label: "Recommended Honeypot Channel",
              kind: "text_channel",
              recommendedName: "do-not-post",
              createdRelationship: "haf_configured",
              templateVersion: 1,
              permissionSummary:
                "Keeps the channel writable by @everyone, grants HAF access, and hides it from configured Excluded Roles.",
              validateReuse: async (resourceId) => {
                const channel = resources.channels.find(
                  (candidate) => candidate.id === resourceId && candidate.type === 0,
                );
                if (!channel) throw new Error("The selected Honeypot Channel is unavailable.");
                return { id: channel.id, name: channel.name, kind: "text_channel" };
              },
              create: async () => {
                const channel = await configureBotDefenseHoneypotChannel(
                  {
                    guildId: body.guildId,
                    botUserId: options.discordBotUserId!,
                    hiddenRoleIds,
                    channelId: existingChannel?.id,
                  },
                  options.discordBotToken,
                );
                return { ...channel, kind: "text_channel" };
              },
              apply: async (resource) => {
                const current = await options.stores.botDefense.readConfig(body.guildId);
                const nowMs = Date.now();
                const next = {
                  ...(current ?? defaultBotDefenseConfig(body.guildId, nowMs)),
                  honeypotChannelIds: [
                    ...new Set([...(current?.honeypotChannelIds ?? []), resource.id]),
                  ],
                  updatedAtMs: nowMs,
                };
                const limitError = getBotDefenseHoneypotChannelLimitError(next.honeypotChannelIds);
                if (limitError) throw new Error(limitError);
                await commitVersionedConfigurationMutation({
                  revisions: options.stores.configurationRevisions,
                  entitlements: options.stores.guildEntitlements,
                  mutation: {
                    guildId: body.guildId,
                    feature: "bot-defense",
                    resourceKey: "default",
                    current,
                    next,
                    adapter: botDefenseRevisionAdapter,
                    actor,
                  },
                  commitFree: () => options.stores.botDefense.upsertConfig(next),
                });
              },
            },
          ],
          readConfiguration: async () => {
            const config = await options.stores.botDefense.readConfig(body.guildId);
            return {
              enabled: config?.honeypotEnabled ?? false,
              dormant: false,
              resourceIds: { honeypot_channel: config?.honeypotChannelIds[0] ?? null },
            };
          },
        };
        const run = await new FeatureSetupRunner(options.stores.featureSetup).execute(
          definition,
          "admin-ui",
          { honeypot_channel: { action: "create", name: "do-not-post" } },
        );
        const resolution = run.resolutions.find(
          (candidate) => candidate.dependencyKey === "honeypot_channel",
        );
        if (!resolution) {
          return Response.json(
            { error: run.failureMessage ?? "Honeypot Channel setup did not complete.", run },
            { status: 409 },
          );
        }
        return Response.json({
          channel: { id: resolution.resource.id, name: resolution.resource.name },
          created: !existingChannel,
          run,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/bot-defense/config",
      body: botDefenseConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "botDefense",
      handler: async ({ body, request, adminRequest }) => {
        const existing = await options.stores.botDefense.readConfig(body.guildId);
        const entitlement = await options.stores.guildEntitlements.readGuildEntitlement(
          body.guildId,
        );
        if (!getGuildEntitlementLimits(entitlement.tier).paidFeatures) {
          const paidControl = findChangedPaidBotDefenseControl(body, existing);
          if (paidControl) return paidCapabilityResponse(paidControl);
        }
        const honeypotChannelIds = body.honeypotChannelIds ?? [];
        const excludedRoleIds = body.excludedRoleIds ?? [];
        const modRoleIds = body.modRoleIds ?? [];
        const rateChannelThreshold = body.rateChannelThreshold ?? 5;
        const rateWindowSeconds = body.rateWindowSeconds ?? 60;

        const resources = await getCachedGuildTicketResources(
          body.guildId,
          options.discordBotToken,
          true,
        );
        const channelIds = new Set(resources.channels.map((channel) => channel.id));
        const roleIds = new Set(resources.roles.map((role) => role.id));

        if (body.modQueueChannelId && !channelIds.has(body.modQueueChannelId)) {
          return Response.json(
            { error: "Mod Queue channel does not exist in this Guild." },
            { status: 400 },
          );
        }

        for (const channelId of honeypotChannelIds) {
          if (!channelIds.has(channelId)) {
            return Response.json(
              { error: `Honeypot channel ${channelId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        for (const roleId of excludedRoleIds) {
          if (!roleIds.has(roleId)) {
            return Response.json(
              { error: `Excluded role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        for (const roleId of modRoleIds) {
          if (!roleIds.has(roleId)) {
            return Response.json(
              { error: `Mod role ${roleId} does not exist in this Guild.` },
              { status: 400 },
            );
          }
        }

        const managedHoneypotChannel = resources.channels.find(
          (channel) =>
            honeypotChannelIds.includes(channel.id) &&
            channel.type === 0 &&
            channel.topic === BOT_DEFENSE_HONEYPOT_CHANNEL_TOPIC,
        );
        if (managedHoneypotChannel && options.discordBotUserId) {
          await configureBotDefenseHoneypotChannel(
            {
              guildId: body.guildId,
              botUserId: options.discordBotUserId,
              hiddenRoleIds: excludedRoleIds.filter(
                (roleId) => resources.roles.find((role) => role.id === roleId)?.managed !== true,
              ),
              channelId: managedHoneypotChannel.id,
            },
            options.discordBotToken,
          );
        }

        const nowMs = Date.now();
        const config = {
          guildId: body.guildId,
          honeypotEnabled: body.honeypotEnabled,
          honeypotWarnUser: body.honeypotWarnUser ?? false,
          honeypotDeleteMessage: body.honeypotDeleteMessage ?? false,
          rateEnabled: body.rateEnabled,
          rateWarnUser: body.rateWarnUser ?? false,
          rateDeleteMessage: body.rateDeleteMessage ?? false,
          honeypotChannelIds,
          rateChannelThreshold,
          rateWindowSeconds,
          excludedRoleIds,
          modRoleIds,
          modQueueChannelId: body.modQueueChannelId ?? null,
          pingOnQueuePost: body.pingOnQueuePost ?? true,
          createdAtMs: existing?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
        };
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "bot-defense",
            resourceKey: "default",
            current: existing,
            next: config,
            adapter: botDefenseRevisionAdapter,
            actor: await configurationActor(options, request, adminRequest),
          },
          commitFree: () => options.stores.botDefense.upsertConfig(config),
        });
        return Response.json({ guildId: body.guildId, config });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/bot-defense/delete",
      body: z.object({ guildId: z.string().min(1, "Missing guildId") }),
      access: bodyGuildScopedAccess("write"),
      feature: "botDefense",
      handler: async ({ body, request, adminRequest }) => {
        const existing = await options.stores.botDefense.readConfig(body.guildId);
        await commitVersionedConfigurationMutation({
          revisions: options.stores.configurationRevisions,
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: "bot-defense",
            resourceKey: "default",
            current: existing,
            next: null,
            adapter: botDefenseRevisionAdapter,
            actor: await configurationActor(options, request, adminRequest),
          },
          commitFree: () => options.stores.botDefense.deleteConfig(body.guildId),
        });
        return Response.json({ ok: true });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/member-verification",
      query: reactionLimitsQuerySchema,
      access: guildScopedAccess("read"),
      feature: "memberVerification",
      handler: async ({ query }) => {
        const guildId = requireGuildQueryId(query);
        return Response.json(await requireMemberVerification().readAdminSnapshot(guildId));
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/member-verification/config",
      body: memberVerificationConfigBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "memberVerification",
      handler: async ({ body, request, adminRequest }) => {
        const result = await requireMemberVerification().saveAdminConfig({
          ...body,
          actor: await configurationActor(options, request, adminRequest),
        });
        if (result.outcome === "invalid") {
          return Response.json(
            {
              error:
                result.reason === "verified-role-required"
                  ? "Select a Verified Role to enable Member Verification."
                  : "Select a Welcome Channel when using Channel panel delivery.",
            },
            { status: 400 },
          );
        }
        if (result.outcome === "method-unavailable") {
          const messages = {
            "advanced-method-paid": "Enhanced verification methods require a paid plan.",
            "turnstile-runtime-unavailable":
              "Turnstile verification is not configured for this runtime.",
            "steam-link-runtime-unavailable":
              "Steam Link verification is not available for this runtime.",
            "steam-link-guild-config-missing":
              "Configure Steam Link for this Guild before selecting Steam Link verification.",
          } as const;
          return Response.json(
            { error: messages[result.reason] },
            { status: result.reason === "advanced-method-paid" ? 402 : 400 },
          );
        }
        return Response.json({
          guildId: body.guildId,
          config: result.config,
          outcome: result.outcome,
          ...(result.outcome === "saved" ? { panelOutcome: result.panelOutcome } : {}),
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/member-verification/panel/publish",
      body: memberVerificationPanelPublishBodySchema,
      access: bodyGuildScopedAccess("write"),
      feature: "memberVerification",
      handler: async ({ body }) => {
        const result = await requireMemberVerification().repairWelcomePanel(body.guildId);
        if (result.outcome === "failed") {
          return Response.json(
            { error: "The verification panel could not be published or repaired." },
            { status: 502 },
          );
        }
        if (result.outcome === "not-eligible") {
          return result.reason === "not-configured"
            ? Response.json(
                { error: "Save Member Verification before publishing its panel." },
                { status: 404 },
              )
            : Response.json(
                { error: "Member Verification is not ready for channel panel delivery." },
                { status: 409 },
              );
        }
        return Response.json({
          guildId: body.guildId,
          panelMessageId: result.panelMessageId,
          outcome: result.outcome,
        });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/member-verification/send-welcome-dm",
      body: z.object({
        guildId: z.string().min(1, "Missing guildId"),
        userId: z.string().min(1, "Missing userId"),
      }),
      access: bodyGuildScopedAccess("write"),
      feature: "memberVerification",
      handler: async ({ body, request }) => {
        const actorUserId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
        if (!actorUserId) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const result = await requireMemberVerification().sendManualWelcomeDm({
          guildId: body.guildId,
          userId: body.userId,
          actorUserId,
        });
        return manualWelcomeDmResponse(result);
      },
    }),
  ];
}

function manualWelcomeDmResponse(result: ManualWelcomeDmResult): Response {
  switch (result.outcome) {
    case "sent":
      return Response.json({ ok: true, outcome: "delivered" });
    case "not-member":
      return Response.json({ error: "Member not found." }, { status: 404 });
    case "rate-limited":
      return Response.json(
        { error: "A verification DM was sent too recently. Try again later." },
        {
          status: 429,
          headers: { "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) },
        },
      );
    case "disabled":
      return Response.json({ error: "Member Verification is disabled." }, { status: 409 });
    case "channel-mode":
      return Response.json(
        { error: "Member Verification uses a channel panel for this Guild." },
        { status: 409 },
      );
    case "method-unavailable":
      return Response.json({ error: "Member Verification is unavailable." }, { status: 409 });
    case "not-configured":
      return Response.json({ error: "Member Verification is not configured." }, { status: 409 });
    case "paid-required":
      return Response.json(
        { error: "Enhanced verification methods require a paid plan." },
        { status: 402 },
      );
    case "undeliverable":
      return Response.json(
        { error: "The verification DM could not be delivered." },
        { status: 502 },
      );
  }
}

async function configurationActor(
  options: GuildFeaturesAdminRoutesOptions,
  request: Request,
  adminRequest?: { operationId: string; correlationId: string },
): Promise<ConfigurationActorContext> {
  const session = options.readCustomerAdminSession
    ? await options.readCustomerAdminSession(request)
    : null;
  return {
    actorUserId: session?.user.discordUserId ?? null,
    source: "dashboard-save",
    operationId: adminRequest?.operationId ?? "configuration.save",
    correlationId: adminRequest?.correlationId ?? null,
  };
}

async function readGuildR2Usage(
  store: GuildFeaturesAdminRoutesOptions["stores"]["guildR2Objects"],
  guildId: string,
) {
  if ("getGuildUsage" in store && typeof store.getGuildUsage === "function") {
    return store.getGuildUsage(guildId);
  }
  return {
    usedBytes: await store.getGuildUsageBytes(guildId),
    reservedBytes: 0,
    lastReconciledAtMs: null,
  };
}

function buildEvidenceFieldEnumValueUsage(
  definitions: EvidenceFieldDefinition[],
  records: EvidenceVaultRecord[],
): Record<string, Record<string, number>> {
  const enumFieldKeys = new Set(
    definitions
      .filter((field) => field.type === "enum" && field.key.trim())
      .map((field) => field.key.trim()),
  );
  const usage: Record<string, Record<string, number>> = {};
  for (const record of records) {
    for (const fieldValue of record.evidenceFieldValues ?? []) {
      if (!enumFieldKeys.has(fieldValue.key)) continue;
      usage[fieldValue.key] ??= {};
      usage[fieldValue.key][fieldValue.value] = (usage[fieldValue.key][fieldValue.value] ?? 0) + 1;
    }
  }
  return usage;
}

function allocateEvidenceFieldKey(
  requestedKey: string | undefined,
  label: string,
  usedKeys: Set<string>,
): string {
  const base = normalizeEvidenceFieldKey(requestedKey || label);
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

function normalizeEvidenceFieldKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function normalizeEvidenceFieldAllowedValues(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}
