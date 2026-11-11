import { z } from "zod";
import { validateWebhookRegex } from "../../security/safe-webhook-regex";
import { adminOperationErrors, defineAdminOperation } from "./core";

const webhookGuildQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().optional(),
});

const webhookProxyQuerySchema = webhookGuildQuerySchema.extend({
  publicId: z.string().min(1).optional(),
  limit: z.string().optional(),
});

const publicIdFieldSchema = z
  .union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid publicId")])
  .optional()
  .transform((value) => (value ? value : undefined));

const webhookProxyIdSchema = z
  .string()
  .min(1, "Invalid id")
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

const httpsUrlFieldSchema = z.string().refine(
  (value) => {
    try {
      if (
        value !== value.trim() ||
        Array.from(value).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        }) ||
        /%2f/i.test(value)
      )
        return false;
      const url = new URL(value);
      const hosts = new Set([
        "discord.com",
        "canary.discord.com",
        "ptb.discord.com",
        "discordapp.com",
      ]);
      const parts = url.pathname.split("/");
      return (
        url.protocol === "https:" &&
        hosts.has(url.hostname.toLowerCase()) &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        !url.pathname.includes("//") &&
        !url.pathname.endsWith("/") &&
        parts.length === 5 &&
        parts[1] === "api" &&
        parts[2] === "webhooks" &&
        /^\d{6,32}$/.test(parts[3] ?? "") &&
        /^[A-Za-z0-9_-]{1,256}$/.test(parts[4] ?? "")
      );
    } catch {
      return false;
    }
  },
  { message: "Invalid Discord webhook URL" },
);

const routingRegexFlagsSchema = z
  .string()
  .regex(/^[imsuy]*$/, "Invalid flags")
  .refine((value) => new Set(value).size === value.length, "Invalid flags");

const replacementRegexFlagsSchema = z
  .string()
  .regex(/^[gimsuy]*$/, "Invalid flags")
  .refine((value) => new Set(value).size === value.length, "Invalid flags");

const compilableRegexSchema = z
  .string()
  .max(256, "Regex patterns cannot exceed 256 characters")
  .refine((pattern) => validateWebhookRegex(pattern) === null, "Invalid or unsafe regex");

function regexCompilesWithFlags(pattern: string, flags: string | undefined): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

const credentialActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preserve"), credentialId: z.string().uuid() }),
  z.object({ action: z.literal("replace"), url: httpsUrlFieldSchema }),
]);

const destinationSchema = z.object({
  id: webhookProxyIdSchema,
  label: z
    .string()
    .min(1, "Missing label")
    .transform((value) => value.trim()),
  credential: credentialActionSchema,
});

const adminRoutingRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pattern: z.string(),
  flags: z.string(),
  destinationIds: z.array(z.string().min(1)).min(1),
});

const adminContentReplacementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pattern: z.string(),
  flags: z.string(),
  replacement: z.string().min(1),
});

const routingRuleSchema = adminRoutingRuleSchema.extend({
  id: webhookProxyIdSchema,
  label: z
    .string()
    .min(1, "Missing label")
    .transform((value) => value.trim()),
  pattern: compilableRegexSchema,
  flags: routingRegexFlagsSchema.optional(),
  destinationIds: z.array(webhookProxyIdSchema).min(1, "Missing destinationIds"),
});

const contentReplacementSchema = adminContentReplacementSchema.extend({
  id: webhookProxyIdSchema,
  label: z
    .string()
    .min(1, "Missing label")
    .transform((value) => value.trim()),
  pattern: compilableRegexSchema,
  flags: replacementRegexFlagsSchema.optional(),
  replacement: z
    .string()
    .min(1, "Missing replacement")
    .max(1_024, "Replacement cannot exceed 1,024 characters"),
});

export const webhookProxyConfigBodySchema = z
  .object({
    guildId: z.string().min(1, "Missing guildId"),
    workspaceId: z.string().optional(),
    publicId: publicIdFieldSchema,
    name: z
      .string()
      .min(1, "Missing name")
      .transform((value) => value.trim()),
    enabled: z.boolean({ error: () => "Missing enabled" }),
    banLookupEnabled: z.boolean().optional().default(false),
    banLookupCredential: z
      .union([credentialActionSchema, z.object({ action: z.literal("clear") })])
      .optional()
      .default({ action: "clear" }),
    banLookupAppIds: z.array(z.number().int().positive()).optional().default([]),
    destinations: z
      .array(destinationSchema)
      .min(1, "Add between 1 and 25 webhook destinations.")
      .max(25, "Add between 1 and 25 webhook destinations."),
    defaultDestinationIds: z.array(webhookProxyIdSchema).min(1, "Missing defaultDestinationIds"),
    routingRules: z
      .array(routingRuleSchema)
      .max(25, "Webhook routing rules cannot exceed 25 entries."),
    contentReplacements: z
      .array(contentReplacementSchema)
      .max(25, "Webhook content replacements cannot exceed 25 entries.")
      .optional(),
  })
  .superRefine((data, ctx) => {
    const destinationIds = new Set(data.destinations.map((destination) => destination.id));
    const seenDestinationIds = new Set<string>();

    data.destinations.forEach((destination, index) => {
      if (seenDestinationIds.has(destination.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["destinations", index, "id"],
          message: "Duplicate destinations entry",
        });
      }
      seenDestinationIds.add(destination.id);
    });

    const seenDefaultIds = new Set<string>();
    data.defaultDestinationIds.forEach((id, index) => {
      if (!destinationIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultDestinationIds", index],
          message: "Unknown destinations entry",
        });
      }
      if (seenDefaultIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["defaultDestinationIds", index],
          message: "Duplicate destinations entry",
        });
      }
      seenDefaultIds.add(id);
    });

    const seenRoutingIds = new Set<string>();
    data.routingRules.forEach((rule, index) => {
      if (!regexCompilesWithFlags(rule.pattern, rule.flags)) {
        ctx.addIssue({
          code: "custom",
          path: ["routingRules", index, "pattern"],
          message: "Invalid regex for the selected flags",
        });
      }
      if (seenRoutingIds.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["routingRules", index, "id"],
          message: "Duplicate routingRules entry",
        });
      }
      seenRoutingIds.add(rule.id);

      const seenRuleDestIds = new Set<string>();
      rule.destinationIds.forEach((destId, destIndex) => {
        if (!destinationIds.has(destId)) {
          ctx.addIssue({
            code: "custom",
            path: ["routingRules", index, "destinationIds", destIndex],
            message: "Unknown destinations entry",
          });
        }
        if (seenRuleDestIds.has(destId)) {
          ctx.addIssue({
            code: "custom",
            path: ["routingRules", index, "destinationIds", destIndex],
            message: "Duplicate destinations entry",
          });
        }
        seenRuleDestIds.add(destId);
      });
    });

    const seenReplacementIds = new Set<string>();
    (data.contentReplacements ?? []).forEach((replacement, index) => {
      if (!regexCompilesWithFlags(replacement.pattern, replacement.flags)) {
        ctx.addIssue({
          code: "custom",
          path: ["contentReplacements", index, "pattern"],
          message: "Invalid regex for the selected flags",
        });
      }
      if (seenReplacementIds.has(replacement.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["contentReplacements", index, "id"],
          message: "Duplicate contentReplacements entry",
        });
      }
      seenReplacementIds.add(replacement.id);
    });
  });

export const webhookProxyCredentialRevealBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  publicId: z.string().min(1),
  destinationId: z.string().min(1),
});

export const webhookProxyBanCredentialRevealBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  publicId: z.string().min(1),
});

export const webhookProxyDeleteBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  publicId: z.string().min(1),
});

const maskedCredentialSchema = z.object({
  configured: z.literal(true),
  credentialId: z.string().min(1),
  provider: z.literal("discord"),
  fingerprint: z.string(),
  maskedDisplay: z.string(),
});

const guardSnapshotSchema = z.object({
  activeLeases: z.number().int(),
  tokens: z.number().nullable(),
  updatedAtMs: z.number().int().nullable(),
  outcomes: z.object({}),
  sampledAtMs: z.number().int(),
});

const adminDestinationSchema = z.object({
  id: z.string(),
  label: z.string(),
  credential: maskedCredentialSchema,
});

const adminConfigSchema = z.object({
  guildId: z.string(),
  publicId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  banLookupEnabled: z.boolean(),
  banLookupCredential: maskedCredentialSchema.nullable(),
  banLookupAppIds: z.array(z.number().int()),
  destinations: z.array(adminDestinationSchema),
  defaultDestinationIds: z.array(z.string()),
  routingRules: z.array(adminRoutingRuleSchema),
  contentReplacements: z.array(adminContentReplacementSchema),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

const forwardLogSchema = z.object({
  guildId: z.string(),
  id: z.string(),
  publicId: z.string(),
  destinationId: z.string(),
  credentialFingerprint: z.string().nullable().optional(),
  status: z.number().int().nullable(),
  ok: z.boolean(),
  attempt: z.number().int(),
  error: z.string().nullable(),
  timestampMs: z.number(),
});

const readErrors = [
  adminOperationErrors.invalidRequest,
  adminOperationErrors.authenticationRequired,
  adminOperationErrors.permissionDenied,
  adminOperationErrors.entitlementRequired,
  adminOperationErrors.resourceNotFound,
  adminOperationErrors.unavailable,
  adminOperationErrors.internal,
] as const;
const writeErrors = [
  ...readErrors,
  adminOperationErrors.conflict,
  adminOperationErrors.discordRateLimited,
] as const;
const metadata = {
  tags: ["Webhooks"],
  feature: "webhookProxy",
  entitlement: "premium-only-features",
} as const;

export const getWebhookProxy = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxy.get",
  method: "GET",
  path: "/admin/api/webhook-proxy",
  summary: "List Webhook Proxy configurations",
  query: webhookGuildQuerySchema,
  success: {
    status: 200,
    schema: z.object({ guildId: z.string(), configs: z.array(adminConfigSchema) }),
    description: "Webhook Proxy configurations for the Guild",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const getWebhookProxyIngressHealth = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyIngressHealth.get",
  method: "GET",
  path: "/admin/api/webhook-proxy/ingress-health",
  summary: "Read Webhook Proxy ingress health",
  query: webhookProxyQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      publicId: z.string(),
      product: z.literal("webhook-proxy"),
      source: guardSnapshotSchema,
      global: guardSnapshotSchema,
      invalidSources: guardSnapshotSchema,
    }),
    description: "Ingress rate-limit health for a Webhook Proxy",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const saveWebhookProxy = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyConfig.post",
  method: "POST",
  path: "/admin/api/webhook-proxy/config",
  summary: "Save a Webhook Proxy configuration",
  body: webhookProxyConfigBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true), publicId: z.string() }),
    description: "The saved Webhook Proxy public ID",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const revealWebhookProxyCredential = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyCredentialReveal.post",
  method: "POST",
  path: "/admin/api/webhook-proxy/credential/reveal",
  summary: "Reveal a Webhook Proxy destination credential",
  body: webhookProxyCredentialRevealBodySchema,
  success: {
    status: 200,
    schema: z.object({ url: z.string(), fingerprint: z.string(), expiresAtMs: z.number() }),
    description: "A short-lived Webhook Proxy destination URL",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const revealWebhookProxyBanCredential = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyBanCredentialReveal.post",
  method: "POST",
  path: "/admin/api/webhook-proxy/ban-notification-credential/reveal",
  summary: "Reveal the Webhook Proxy ban notification credential",
  body: webhookProxyBanCredentialRevealBodySchema,
  success: {
    status: 200,
    schema: z.object({ url: z.string(), fingerprint: z.string(), expiresAtMs: z.number() }),
    description: "A short-lived ban notification webhook URL",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const deleteWebhookProxy = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyDelete.post",
  method: "POST",
  path: "/admin/api/webhook-proxy/delete",
  summary: "Delete a Webhook Proxy configuration",
  body: webhookProxyDeleteBodySchema,
  success: {
    status: 200,
    schema: z.object({ ok: z.literal(true) }),
    description: "The Webhook Proxy configuration was deleted",
  },
  errors: writeErrors,
  access: { scope: "guild", mode: "write" },
});

export const listWebhookProxyLogs = defineAdminOperation({
  ...metadata,
  operationId: "webhookProxyLogs.get",
  method: "GET",
  path: "/admin/api/webhook-proxy/logs",
  summary: "List Webhook Proxy delivery logs",
  query: webhookProxyQuerySchema,
  success: {
    status: 200,
    schema: z.object({
      guildId: z.string(),
      publicId: z.string(),
      logs: z.array(forwardLogSchema),
    }),
    description: "Recent Webhook Proxy delivery attempts",
  },
  errors: readErrors,
  access: { scope: "guild", mode: "read" },
});

export const webhookProxyContracts = {
  get: getWebhookProxy,
  ingressHealth: getWebhookProxyIngressHealth,
  save: saveWebhookProxy,
  revealCredential: revealWebhookProxyCredential,
  revealBanCredential: revealWebhookProxyBanCredential,
  delete: deleteWebhookProxy,
  logs: listWebhookProxyLogs,
} as const;
