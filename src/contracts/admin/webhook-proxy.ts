import { z } from "zod";
import { adminOperationErrors, defineAdminOperation } from "./core";

const webhookGuildQuerySchema = z.object({
  guildId: z.string().min(1).optional(),
  workspaceId: z.string().optional(),
});

const webhookProxyQuerySchema = webhookGuildQuerySchema.extend({
  publicId: z.string().min(1).optional(),
  limit: z.string().optional(),
});

const credentialActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preserve"), credentialId: z.string().min(1) }),
  z.object({ action: z.literal("replace"), url: z.string().min(1) }),
]);

const destinationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  credential: credentialActionSchema,
});

const routingRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pattern: z.string(),
  flags: z.string().optional(),
  destinationIds: z.array(z.string().min(1)).min(1),
});

const contentReplacementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  pattern: z.string(),
  flags: z.string().optional(),
  replacement: z.string().min(1),
});
const adminRoutingRuleSchema = routingRuleSchema.extend({ flags: z.string() });
const adminContentReplacementSchema = contentReplacementSchema.extend({ flags: z.string() });

export const webhookProxyConfigBodySchema = z.object({
  guildId: z.string().min(1),
  workspaceId: z.string().optional(),
  publicId: z.union([z.literal(""), z.string().min(1)]).optional(),
  name: z.string().min(1),
  enabled: z.boolean(),
  banLookupEnabled: z.boolean().optional(),
  banLookupCredential: z
    .union([credentialActionSchema, z.object({ action: z.literal("clear") })])
    .optional(),
  banLookupAppIds: z.array(z.number().int().positive()).optional(),
  destinations: z.array(destinationSchema).min(1).max(25),
  defaultDestinationIds: z.array(z.string().min(1)).min(1),
  routingRules: z.array(routingRuleSchema).max(25),
  contentReplacements: z.array(contentReplacementSchema).max(25).optional(),
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
  destinationUrl: z.string().optional(),
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
