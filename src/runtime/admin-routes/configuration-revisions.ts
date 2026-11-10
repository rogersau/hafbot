import { configurationRevisionContracts } from "../../contracts/admin";
import {
  canonicalConfigurationJson,
  diffConfigurationSnapshots,
  hashConfigurationSnapshot,
  type ConfigurationActorContext,
  type ConfigurationFeatureKey,
  type ConfigurationRevision,
  type ConfigurationSnapshotEnvelope,
} from "../../configuration-revisions";
import { configurationRevisionAdapters } from "../../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../../configuration-revisions/coordinator";
import {
  signConfigurationRestoreToken,
  verifyConfigurationRestoreToken,
} from "../../configuration-revisions/restore-token";
import { adminErrorEnvelopeSchema } from "../../contracts/admin";
import { defineRoute, type Route } from "../admin-route-registry";
import { guildScopedAccess } from "../admin-route-guards";
import { bodyGuildScopedAccess } from "../admin-route-guards";
import type { AdminRoutesOptions } from "./index";
import { getCachedGuildTicketResources } from "../admin-discord-cache";
import type {
  BotDefenseConfig,
  GuildAuditLogConfig,
  MemberVerificationConfig,
  MentionProtectionConfig,
  WebhookProxyConfig,
} from "../../types";
import { getBotDefenseHoneypotChannelLimitError } from "../../bot-defense-config";
import { isRecord } from "../../unknown-parse";
import { validateWebhookRegex } from "../../security/safe-webhook-regex";

export function createConfigurationRevisionAdminRoutes(
  options: AdminRoutesOptions,
): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...configurationRevisionContracts.restore,
      feature: undefined,
      success: configurationRevisionContracts.restore.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      handler: async ({ body, request, adminRequest }) => {
        const signingSecret = requireSigningSecret(options);
        let token;
        try {
          token = await verifyConfigurationRestoreToken(body.previewToken, signingSecret);
        } catch (error) {
          return Response.json(
            {
              error:
                error instanceof Error && error.message === "restore_preview_expired"
                  ? "Restore preview expired. Create a new preview."
                  : "Restore preview is invalid. Create a new preview.",
            },
            { status: 409 },
          );
        }
        let state;
        try {
          state = await prepareGenericRestore(options, body);
        } catch (error) {
          return conflict(error);
        }
        if (
          token.guildId !== body.guildId ||
          token.feature !== body.feature ||
          token.resourceKey !== body.resourceKey ||
          token.targetRevisionId !== body.revisionId ||
          token.currentHeadId !== state.head.id ||
          token.currentSnapshotHash !== state.currentSnapshotHash ||
          token.targetSnapshotHash !== state.targetSnapshotHash ||
          token.entitlementTier !== state.entitlementTier
        ) {
          return conflict(
            new Error(
              "Configuration, entitlement, or Discord resources changed. Create a new preview.",
            ),
          );
        }
        if (state.requiredSecretInputs.length > 0) {
          return conflict(
            new Error(
              `Secret replacement or omission is required for: ${state.requiredSecretInputs.join(", ")}`,
            ),
          );
        }
        const next = await materializeWebhookReplacementCredentials(options, state.next, body);
        await commitVersionedConfigurationMutation({
          revisions: requireRevisionStore(options),
          entitlements: options.stores.guildEntitlements,
          mutation: {
            guildId: body.guildId,
            feature: body.feature,
            resourceKey: body.resourceKey,
            current: state.current,
            next,
            adapter: state.adapter,
            actor: await readActor(options, request, adminRequest, "restore"),
            operation: "restore",
            restoredFromRevisionId: body.revisionId,
          },
          commitFree: async () => {
            throw new Error("Configuration revision restore requires a Premium plan.");
          },
        });
        return Response.json({ ok: true, followUpActions: state.followUpActions });
      },
    }),
    defineRoute({
      ...configurationRevisionContracts.restorePreview,
      feature: undefined,
      success: configurationRevisionContracts.restorePreview.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      paidOnly: "premium-only-features",
      handler: async ({ body }) => {
        try {
          const state = await prepareGenericRestore(options, body);
          const expiresAtMs = Date.now() + 10 * 60 * 1_000;
          return Response.json({
            diff: diffConfigurationSnapshots(
              canonicalConfigurationJson(state.adapter.serialize(state.current, body.resourceKey)),
              canonicalConfigurationJson(state.adapter.serialize(state.next, body.resourceKey)),
              state.adapter.display,
            ),
            warnings: state.warnings,
            requiredSecretInputs: state.requiredSecretInputs,
            followUpActions: state.followUpActions,
            previewToken: await signConfigurationRestoreToken(
              {
                version: 1,
                guildId: body.guildId,
                feature: body.feature,
                resourceKey: body.resourceKey,
                targetRevisionId: body.revisionId,
                currentHeadId: state.head.id,
                currentSnapshotHash: state.currentSnapshotHash,
                targetSnapshotHash: state.targetSnapshotHash,
                entitlementTier: state.entitlementTier,
                expiresAtMs,
                nonce: crypto.randomUUID(),
              },
              requireSigningSecret(options),
            ),
            expiresAtMs,
            destructive: state.next === null,
          });
        } catch (error) {
          return conflict(error);
        }
      },
    }),
    defineRoute({
      ...configurationRevisionContracts.list,
      feature: undefined,
      success: configurationRevisionContracts.list.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      handler: async ({ query }) => {
        const revisions = requireRevisionStore(options);
        const page = await revisions.list({
          guildId: query.guildId,
          feature: query.feature,
          resourceKey: query.resourceKey,
          limit: parseLimit(query.limit, 100),
          beforeCreatedAtMs: parseCursor(query.beforeCreatedAtMs),
        });
        return Response.json({
          revisions: page.revisions.map(withoutSnapshot),
          nextCursor: page.nextCursor,
        });
      },
    }),
    defineRoute({
      ...configurationRevisionContracts.compare,
      feature: undefined,
      success: configurationRevisionContracts.compare.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      handler: async ({ query }) => {
        const revisions = requireRevisionStore(options);
        const [before, after] = await Promise.all([
          query.beforeRevisionId
            ? revisions.readById({
                guildId: query.guildId,
                revisionId: query.beforeRevisionId,
              })
            : null,
          revisions.readById({
            guildId: query.guildId,
            revisionId: query.afterRevisionId,
          }),
        ]);
        if (
          !after ||
          (before && (before.feature !== after.feature || before.resourceKey !== after.resourceKey))
        ) {
          return Response.json(
            { error: "Configuration revision comparison not found." },
            {
              status: 404,
            },
          );
        }
        const adapter = configurationRevisionAdapters.get(after.feature);
        return Response.json({
          diff: diffConfigurationSnapshots(
            before?.snapshotJson ?? null,
            after.snapshotJson,
            adapter.display,
          ),
        });
      },
    }),
    defineRoute({
      ...configurationRevisionContracts.detail,
      feature: undefined,
      success: configurationRevisionContracts.detail.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      handler: async ({ query }) => {
        const revision = await requireRevisionStore(options).readById({
          guildId: query.guildId,
          revisionId: query.revisionId,
        });
        return revision
          ? Response.json({ revision })
          : Response.json({ error: "Configuration revision not found." }, { status: 404 });
      },
    }),
    defineRoute({
      ...configurationRevisionContracts.export,
      feature: undefined,
      success: configurationRevisionContracts.export.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      paidOnly: "premium-only-features",
      handler: async ({ query }) => {
        const store = requireRevisionStore(options);
        if (!store.listGuild) {
          return Response.json(
            { error: "Configuration revision export is unavailable." },
            {
              status: 503,
            },
          );
        }
        const page = await store.listGuild({
          guildId: query.guildId,
          limit: parseLimit(query.limit, 1_000),
          beforeCreatedAtMs: parseCursor(query.beforeCreatedAtMs),
        });
        const headers = {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="configuration-revisions.${query.format === "jsonl" ? "jsonl" : "json"}"`,
          "content-type": "application/json; charset=utf-8",
        };
        if (query.format === "jsonl") {
          return new Response(
            page.revisions.map((revision) => JSON.stringify(revision)).join("\n"),
            { headers },
          );
        }
        return new Response(
          JSON.stringify({ revisions: page.revisions, nextCursor: page.nextCursor }),
          { headers },
        );
      },
    }),
  ];
}

function requireRevisionStore(options: AdminRoutesOptions) {
  if (!options.stores.configurationRevisions) {
    throw new Error("Configuration revision storage is unavailable.");
  }
  return options.stores.configurationRevisions;
}

function withoutSnapshot(revision: ConfigurationRevision) {
  const { snapshotJson: _snapshotJson, ...summary } = revision;
  return summary;
}

function parseLimit(value: string | undefined, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : 50;
}

function parseCursor(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

type RestoreRequest = {
  guildId: string;
  feature: ConfigurationFeatureKey;
  resourceKey: string;
  revisionId: string;
  secretReplacements?: Array<{ slot: string; value: string }>;
  omittedSecretSlots?: string[];
};

async function prepareGenericRestore(options: AdminRoutesOptions, request: RestoreRequest) {
  if (request.feature === "tickets") {
    throw new Error("Use the Ticket Panel restore workflow for Ticket revisions.");
  }
  const revisions = requireRevisionStore(options);
  const [revision, entitlement] = await Promise.all([
    revisions.readById({ guildId: request.guildId, revisionId: request.revisionId }),
    options.stores.guildEntitlements.readGuildEntitlement(request.guildId),
  ]);
  if (
    !revision ||
    revision.feature !== request.feature ||
    revision.resourceKey !== request.resourceKey
  ) {
    throw new Error("Configuration revision not found.");
  }
  if (entitlement.tier === "free") {
    throw new Error("Configuration revision restore requires a Premium plan.");
  }
  const adapter = configurationRevisionAdapters.get(request.feature);
  const parsed = parseSnapshot(revision.snapshotJson);
  const target = adapter.migrateSnapshot(parsed);
  const current = await readCurrent(options, request.feature, request.guildId, request.resourceKey);
  const head = await revisions.readHead({
    guildId: request.guildId,
    feature: request.feature,
    resourceKey: request.resourceKey,
  });
  if (!head) throw new Error("Configuration revision head not found.");
  const requiredSecretInputs: string[] = [];
  const next = target.exists
    ? buildRestoreConfiguration(request, current, target, requiredSecretInputs)
    : null;
  if (request.feature === "bot-defense" && isRecord(next)) {
    const channelIds = Array.isArray(next.honeypotChannelIds)
      ? next.honeypotChannelIds.filter((value): value is string => typeof value === "string")
      : [];
    const limitError = getBotDefenseHoneypotChannelLimitError(channelIds);
    if (limitError) throw new Error(limitError);
  }
  validateFeatureAvailability(options, request.feature, next);
  await validateDiscordReferences(options, request.guildId, next);
  const warnings =
    request.feature === "webhook-proxy" ? webhookCredentialWarnings(target, current) : [];
  const followUpActions =
    request.feature === "member-verification"
      ? ["Publish or sync the Member Verification panel if channel delivery is enabled."]
      : request.feature === "bot-defense"
        ? ["Run Feature Resource Setup if restored Bot Defense resources need repair."]
        : [];
  return {
    adapter,
    current,
    next,
    head,
    requiredSecretInputs,
    warnings,
    followUpActions,
    entitlementTier: entitlement.tier,
    currentSnapshotHash: await hashConfigurationSnapshot(
      adapter.serialize(current, request.resourceKey),
    ),
    targetSnapshotHash: await hashConfigurationSnapshot(target),
  };
}

function parseSnapshot(value: string): ConfigurationSnapshotEnvelope<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Configuration revision snapshot is invalid.");
  }
  if (!isRecord(parsed)) throw new Error("Configuration revision snapshot is invalid.");
  return parsed as unknown as ConfigurationSnapshotEnvelope<unknown>;
}

async function readCurrent(
  options: AdminRoutesOptions,
  feature: Exclude<ConfigurationFeatureKey, "tickets">,
  guildId: string,
  resourceKey: string,
): Promise<unknown> {
  switch (feature) {
    case "webhook-proxy": {
      const config = await options.stores.webhookProxy.readWebhookProxyConfig(resourceKey);
      return config?.guildId === guildId ? config : null;
    }
    case "mention-protection":
      return options.stores.mentionProtection.readConfig(guildId);
    case "bot-defense":
      return options.stores.botDefense.readConfig(guildId);
    case "member-verification":
      return options.stores.memberVerification.readConfig(guildId);
    case "guild-audit-log":
      return options.stores.guildAuditLog.readConfig(guildId);
  }
}

function buildRestoreConfiguration(
  request: RestoreRequest,
  current: unknown,
  target: ConfigurationSnapshotEnvelope<unknown>,
  requiredSecretInputs: string[],
): unknown {
  if (!isRecord(target.value)) throw new Error("Configuration revision value is invalid.");
  const value = target.value;
  if (request.feature === "webhook-proxy") {
    return buildWebhookRestore(request, current, value, target.secretSlots, requiredSecretInputs);
  }
  const nowMs = Date.now();
  switch (request.feature) {
    case "mention-protection":
      return {
        ...value,
        guildId: request.guildId,
        createdAtMs:
          isRecord(current) && typeof current.createdAtMs === "number"
            ? current.createdAtMs
            : nowMs,
        updatedAtMs: nowMs,
      } as MentionProtectionConfig;
    case "bot-defense":
      return {
        ...value,
        guildId: request.guildId,
        createdAtMs:
          isRecord(current) && typeof current.createdAtMs === "number"
            ? current.createdAtMs
            : nowMs,
        updatedAtMs: nowMs,
      } as BotDefenseConfig;
    case "member-verification":
      return {
        ...value,
        guildId: request.guildId,
        panelMessageId:
          isRecord(current) && typeof current.panelMessageId === "string"
            ? current.panelMessageId
            : null,
        updatedAtMs: nowMs,
      } as MemberVerificationConfig;
    case "guild-audit-log":
      return {
        ...value,
        guildId: request.guildId,
        updatedAtMs: nowMs,
      } as GuildAuditLogConfig;
    case "tickets":
      throw new Error("Use the Ticket Panel restore workflow.");
  }
}

function buildWebhookRestore(
  request: RestoreRequest,
  currentValue: unknown,
  target: Record<string, unknown>,
  secretSlots: ConfigurationSnapshotEnvelope<unknown>["secretSlots"],
  requiredSecretInputs: string[],
): WebhookProxyConfig {
  const current = isRecord(currentValue) ? (currentValue as unknown as WebhookProxyConfig) : null;
  const targetDestinations = Array.isArray(target.destinations)
    ? target.destinations.filter(isRecord)
    : [];
  const omitted = new Set(request.omittedSecretSlots ?? []);
  const destinations: WebhookProxyConfig["destinations"] = [];
  const destinationsV2: NonNullable<WebhookProxyConfig["destinationsV2"]> = [];
  for (const destination of targetDestinations) {
    if (typeof destination.id !== "string" || typeof destination.label !== "string") continue;
    const slot = `destinations.${destination.id}`;
    if (omitted.has(slot)) continue;
    const currentV2 = current?.destinationsV2?.find((entry) => entry.id === destination.id);
    const currentLegacy = current?.destinations.find((entry) => entry.id === destination.id);
    const replacement = replacementFor(request, slot);
    if (currentV2 && currentLegacy) {
      destinations.push({ id: destination.id, label: destination.label, url: currentLegacy.url });
      destinationsV2.push({
        id: destination.id,
        label: destination.label,
        credentialId: currentV2.credentialId,
      });
    } else if (replacement) {
      destinations.push({ id: destination.id, label: destination.label, url: replacement });
    } else {
      requiredSecretInputs.push(slot);
    }
  }
  const banSlot = secretSlots.banLookupNotification;
  const preserveBan = banSlot?.state === "configured" && current?.banLookupCredentialId;
  if (
    banSlot?.state === "configured" &&
    !preserveBan &&
    !replacementFor(request, "banLookupNotification") &&
    !omitted.has("banLookupNotification")
  ) {
    requiredSecretInputs.push("banLookupNotification");
  }
  const retainedIds = new Set(destinations.map((destination) => destination.id));
  return {
    guildId: request.guildId,
    publicId: request.resourceKey,
    name: typeof target.name === "string" ? target.name : "Webhook Proxy",
    enabled: target.enabled === true,
    banLookupEnabled: target.banLookupEnabled === true,
    banLookupNotificationUrl: preserveBan ? (current?.banLookupNotificationUrl ?? null) : null,
    ...(preserveBan ? { banLookupCredentialId: current!.banLookupCredentialId } : {}),
    banLookupAppIds: Array.isArray(target.banLookupAppIds)
      ? target.banLookupAppIds.filter((value): value is number => typeof value === "number")
      : [],
    destinations,
    destinationsV2,
    defaultDestinationIds: Array.isArray(target.defaultDestinationIds)
      ? target.defaultDestinationIds.filter(
          (value): value is string => typeof value === "string" && retainedIds.has(value),
        )
      : [],
    routingRules: Array.isArray(target.routingRules)
      ? (target.routingRules as WebhookProxyConfig["routingRules"]).map((rule) => ({
          ...rule,
          destinationIds: rule.destinationIds.filter((id) => retainedIds.has(id)),
        }))
      : [],
    contentReplacements: Array.isArray(target.contentReplacements)
      ? (target.contentReplacements as NonNullable<WebhookProxyConfig["contentReplacements"]>)
      : [],
    credentialMigratedAtMs: Date.now(),
    createdAtMs: current?.createdAtMs ?? Date.now(),
    updatedAtMs: Date.now(),
  };
}

async function materializeWebhookReplacementCredentials(
  options: AdminRoutesOptions,
  next: unknown,
  request: RestoreRequest,
): Promise<unknown> {
  if (request.feature !== "webhook-proxy" || !next) return next;
  const config = next as WebhookProxyConfig;
  const service = options.webhookCredentialService;
  if (!service) throw new Error("Webhook credential service is unavailable.");
  const destinationsV2 = [...(config.destinationsV2 ?? [])];
  for (const destination of config.destinations) {
    if (destinationsV2.some((entry) => entry.id === destination.id)) continue;
    const owner = {
      kind: "proxy_destination" as const,
      guildId: config.guildId,
      publicId: config.publicId,
      destinationId: destination.id,
    };
    const masked = await service.replace(owner, destination.url);
    destinationsV2.push({
      id: destination.id,
      label: destination.label,
      credentialId: masked.credentialId,
    });
  }
  let banLookupCredentialId = config.banLookupCredentialId ?? null;
  let banLookupNotificationUrl = config.banLookupNotificationUrl;
  const replacement = replacementFor(request, "banLookupNotification");
  if (replacement) {
    const owner = {
      kind: "ban_lookup_notification" as const,
      guildId: config.guildId,
      publicId: config.publicId,
    };
    const masked = await service.replace(owner, replacement);
    banLookupCredentialId = masked.credentialId;
    banLookupNotificationUrl = replacement;
  }
  return { ...config, destinationsV2, banLookupCredentialId, banLookupNotificationUrl };
}

async function validateDiscordReferences(
  options: AdminRoutesOptions,
  guildId: string,
  configuration: unknown,
): Promise<void> {
  if (!configuration) return;
  const resources = await getCachedGuildTicketResources(guildId, options.discordBotToken, true);
  const channelIds = new Set(resources.channels.map((resource) => resource.id));
  const roleIds = new Set(resources.roles.map((resource) => resource.id));
  const missing: string[] = [];
  walkResourceIds(configuration, "", channelIds, roleIds, missing);
  if (missing.length > 0) {
    throw new Error(`Restore references missing Discord resources: ${missing.join(", ")}`);
  }
}

function walkResourceIds(
  value: unknown,
  path: string,
  channelIds: Set<string>,
  roleIds: Set<string>,
  missing: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkResourceIds(entry, `${path}.${index}`, channelIds, roleIds, missing),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (key === "groupChannelIds" && isRecord(entry)) {
      for (const [group, id] of Object.entries(entry)) {
        if (typeof id === "string" && id && !channelIds.has(id)) {
          missing.push(`${nextPath}.${group}`);
        }
      }
    } else if (typeof entry === "string" && entry) {
      if (key.endsWith("ChannelId") && !channelIds.has(entry)) missing.push(nextPath);
      if (key.endsWith("RoleId") && !roleIds.has(entry)) missing.push(nextPath);
    } else if (Array.isArray(entry) && key.endsWith("ChannelIds")) {
      for (const id of entry)
        if (typeof id === "string" && !channelIds.has(id)) missing.push(nextPath);
    } else if (Array.isArray(entry) && key.endsWith("RoleIds")) {
      for (const id of entry)
        if (typeof id === "string" && !roleIds.has(id)) missing.push(nextPath);
    } else {
      walkResourceIds(entry, nextPath, channelIds, roleIds, missing);
    }
  }
}

function validateFeatureAvailability(
  options: AdminRoutesOptions,
  feature: ConfigurationFeatureKey,
  configuration: unknown,
): void {
  if (!configuration) return;
  if (feature === "member-verification") {
    const config = configuration as MemberVerificationConfig;
    if (
      config.verificationMethod === "turnstile" &&
      (!options.turnstileSiteKey?.trim() || !options.turnstileSecretKey?.trim())
    ) {
      throw new Error("Turnstile verification is not available for this restore.");
    }
    if (config.verificationMethod === "steam-link" && !options.features?.steamLink) {
      throw new Error("Steam Link verification is not available for this restore.");
    }
  }
  if (feature === "webhook-proxy") {
    const config = configuration as WebhookProxyConfig;
    for (const rule of config.routingRules) {
      const validation = validateWebhookRegex(rule.pattern);
      if (validation) throw new Error(`Routing rule ${rule.label}: ${validation}`);
    }
    for (const replacement of config.contentReplacements ?? []) {
      const validation = validateWebhookRegex(replacement.pattern);
      if (validation) {
        throw new Error(`Content replacement ${replacement.label}: ${validation}`);
      }
    }
  }
}

function webhookCredentialWarnings(
  target: ConfigurationSnapshotEnvelope<unknown>,
  current: unknown,
): string[] {
  if (!isRecord(current)) return [];
  const currentSnapshot = configurationRevisionAdapters
    .get("webhook-proxy")
    .serialize(current, target.resourceKey);
  const warnings: string[] = [];
  for (const [slot, historical] of Object.entries(target.secretSlots)) {
    const present = currentSnapshot.secretSlots[slot];
    if (
      historical.state === "configured" &&
      present?.state === "configured" &&
      historical.fingerprint !== present.fingerprint
    ) {
      warnings.push(`Credential changed since this revision; the current ${slot} is preserved.`);
    }
  }
  return warnings;
}

async function readActor(
  options: AdminRoutesOptions,
  request: Request,
  adminRequest: { operationId: string; correlationId: string } | undefined,
  source: "restore" | "dashboard-save",
): Promise<ConfigurationActorContext> {
  const session = options.readCustomerAdminSession
    ? await options.readCustomerAdminSession(request)
    : null;
  return {
    actorUserId: session?.user.discordUserId ?? null,
    source,
    operationId: adminRequest?.operationId ?? "configurationRevision.restore",
    correlationId: adminRequest?.correlationId ?? null,
  };
}

function requireSigningSecret(options: AdminRoutesOptions): string {
  if (!options.configurationRevisionSigningSecret) {
    throw new Error("Configuration revision restore is temporarily unavailable.");
  }
  return options.configurationRevisionSigningSecret;
}

function conflict(error: unknown): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : "Configuration restore conflict." },
    { status: 409 },
  );
}

function replacementFor(request: RestoreRequest, slot: string): string | undefined {
  return request.secretReplacements?.find((replacement) => replacement.slot === slot)?.value.trim();
}
