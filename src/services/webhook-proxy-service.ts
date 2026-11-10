import type { WebhookProxyConfig, WebhookProxyDestination, WebhookProxyForwardLog } from "../types";
import type { WebhookProxyStore } from "../runtime/contracts";
import type { GuildEntitlementStore } from "../runtime/contracts";
import { getGuildEntitlementLimits } from "../types";
import { extractSteamIdsFromBody } from "./steam-ban-lookup-service";
import { isRecord } from "../unknown-parse";
import {
  WebhookCredentialStoreUnavailableError,
  type WebhookCredentialService,
} from "../security/webhook-credentials/store";
import type { OperationalIncidentReporter } from "../operations/incidents";

const WEBHOOK_PROXY_CONFIG_CACHE_TTL_MS = 2 * 60 * 1000;
const WEBHOOK_PROXY_CONFIG_CACHE_MAX_ENTRIES = 1_024;

interface CachedWebhookProxyRule {
  readonly source: WebhookProxyConfig["routingRules"][number];
  readonly destinationIds: readonly string[];
  readonly matcher: RegExp;
}

interface CachedWebhookProxyContentReplacement {
  readonly matcher: RegExp;
  readonly replacement: string;
}

interface CachedWebhookProxyConfig {
  readonly source: WebhookProxyConfig;
  readonly destinationsById: ReadonlyMap<string, WebhookProxyDestination>;
  readonly compiledRules: readonly CachedWebhookProxyRule[];
  readonly compiledReplacements: readonly CachedWebhookProxyContentReplacement[];
}

export interface CachedWebhookProxyConfigEntry {
  readonly expiresAtMs: number;
  readonly promise: Promise<CachedWebhookProxyConfig | null>;
}

export type WebhookProxyConfigCache = Map<string, CachedWebhookProxyConfigEntry>;

export class WebhookProxyNotFoundError extends Error {}
export class WebhookProxyServiceUnavailableError extends Error {}

export interface WebhookProxyServiceOptions {
  fetch?: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  deliveryQueue?: WebhookProxyDeliveryQueue;
  steamBanLookupQueue?: SteamBanLookupQueue;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
  persistDeliveryLogs?: boolean;
  guildEntitlements?: GuildEntitlementStore;
  isGuildSuspended?: (guildId: string) => Promise<boolean>;
  credentialService?: WebhookCredentialService;
  operationalIncidents?: OperationalIncidentReporter;
  configCache?: WebhookProxyConfigCache;
}

export interface WebhookProxyDeliveryQueue {
  send(message: WebhookProxyDeliveryEnvelope): Promise<unknown>;
}

export interface SteamBanLookupQueue {
  send(message: SteamBanLookupQueueMessage): Promise<unknown>;
}

export type SteamBanLookupQueueMessage =
  | {
      version: 2;
      guildId: string;
      publicId: string;
      steamIds: string[];
      notificationCredentialId: string;
      banLookupAppIds: number[];
    }
  | {
      version?: 1;
      guildId: string;
      steamIds: string[];
      notificationUrl: string;
      banLookupAppIds: number[];
    };

export interface WebhookDeliveryTargetRef {
  destinationId: string;
  credentialId: string;
}

export type WebhookProxyDeliveryEnvelope =
  | {
      version: 2;
      config: WebhookProxyDeliveryConfig;
      destinations: readonly WebhookDeliveryTargetRef[];
      body: string;
      contentType: string | null;
    }
  | {
      version?: 1;
      config: WebhookProxyDeliveryConfig;
      destinations: readonly WebhookProxyDestination[];
      body: string;
      contentType: string | null;
    };

export interface WebhookProxyDeliveryConfig {
  guildId: string;
  publicId: string;
}

export type WebhookProxyDeliveryResult =
  | { status: "complete" }
  | { status: "retry"; reasonCode: string; delaySeconds?: number }
  | { status: "terminal"; reasonCode: string };

export interface WebhookProxyAcceptResult {
  publicId: string;
  acceptedDestinations: number;
}

export interface WebhookProxyPayloadEvaluation {
  transformedBody: string;
  matchedRules: WebhookProxyConfig["routingRules"];
  destinations: WebhookProxyDestination[];
  usedDefaultDestinations: boolean;
  steamIds: string[];
}

export class WebhookProxyService {
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly waitUntil?: (promise: Promise<unknown>) => void;
  private readonly deliveryQueue?: WebhookProxyDeliveryQueue;
  private readonly steamBanLookupQueue?: SteamBanLookupQueue;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly persistDeliveryLogs: boolean;
  private readonly guildEntitlements?: GuildEntitlementStore;
  private readonly isGuildSuspended?: (guildId: string) => Promise<boolean>;
  private readonly credentialService?: WebhookCredentialService;
  private readonly operationalIncidents?: OperationalIncidentReporter;
  private readonly configCache: WebhookProxyConfigCache;
  private readonly eligibleConfigCache = new Map<
    string,
    Promise<CachedWebhookProxyConfig | null>
  >();

  constructor(
    private readonly store: WebhookProxyStore,
    options: WebhookProxyServiceOptions = {},
  ) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => fetchImpl.call(globalThis, input, init);
    this.waitUntil = options.waitUntil;
    this.deliveryQueue = options.deliveryQueue;
    this.steamBanLookupQueue = options.steamBanLookupQueue;
    this.sleep =
      options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.persistDeliveryLogs = options.persistDeliveryLogs ?? true;
    this.guildEntitlements = options.guildEntitlements;
    this.isGuildSuspended = options.isGuildSuspended;
    this.credentialService = options.credentialService;
    this.operationalIncidents = options.operationalIncidents;
    this.configCache = options.configCache ?? new Map();
  }

  async handleInboundWebhook(
    publicId: string,
    body: string,
    contentType: string | null,
  ): Promise<WebhookProxyAcceptResult> {
    const config = await this.readEligibleWebhookProxyConfig(publicId);
    if (!config) {
      throw new WebhookProxyNotFoundError("Webhook not found");
    }

    const evaluation = evaluateCachedWebhookProxyPayload(config, body, contentType);
    const destinations = evaluation.destinations;
    await this.enqueueSteamBanLookups(config.source, evaluation.transformedBody);
    if (destinations.length === 0) {
      return { publicId, acceptedDestinations: 0 };
    }

    if (this.deliveryQueue) {
      const refs = destinations.flatMap((destination) => {
        const stored = config.source.destinationsV2?.find((entry) => entry.id === destination.id);
        return stored ? [{ destinationId: stored.id, credentialId: stored.credentialId }] : [];
      });
      await this.deliveryQueue.send(
        refs.length === destinations.length
          ? {
              version: 2,
              config: { guildId: config.source.guildId, publicId: config.source.publicId },
              destinations: refs,
              body: evaluation.transformedBody,
              contentType,
            }
          : {
              config: { guildId: config.source.guildId, publicId: config.source.publicId },
              destinations,
              body: evaluation.transformedBody,
              contentType,
            },
      );
      return { publicId, acceptedDestinations: destinations.length };
    }

    const delivery = Promise.all(
      destinations.map((destination) =>
        this.forwardWithRetry(config.source, destination, evaluation.transformedBody, contentType),
      ),
    ).then(() => undefined);

    if (this.waitUntil) {
      this.waitUntil(
        delivery.catch((error) => console.error("Webhook proxy delivery failed", error)),
      );
    } else {
      await delivery;
    }

    return { publicId, acceptedDestinations: destinations.length };
  }

  async hasInboundWebhookSource(publicId: string): Promise<boolean> {
    return (await this.readEligibleWebhookProxyConfig(publicId)) !== null;
  }

  async readCachedInboundWebhookSource(publicId: string): Promise<boolean | null> {
    const cached = this.getCachedWebhookProxyConfig(publicId);
    return cached ? (await this.readEligibleWebhookProxyConfig(publicId)) !== null : null;
  }

  private async enqueueSteamBanLookups(config: WebhookProxyConfig, body: string): Promise<void> {
    if (
      !this.steamBanLookupQueue ||
      !config.banLookupEnabled ||
      (!config.banLookupCredentialId && !config.banLookupNotificationUrl)
    ) {
      return;
    }

    const steamIds = extractSteamIdsFromBody(body);
    for (let index = 0; index < steamIds.length; index += 100) {
      const chunk = steamIds.slice(index, index + 100);
      if (chunk.length === 0) {
        continue;
      }
      await this.steamBanLookupQueue.send(
        config.banLookupCredentialId
          ? {
              version: 2,
              guildId: config.guildId,
              publicId: config.publicId,
              steamIds: chunk,
              notificationCredentialId: config.banLookupCredentialId,
              banLookupAppIds: config.banLookupAppIds ?? [],
            }
          : {
              guildId: config.guildId,
              steamIds: chunk,
              notificationUrl: config.banLookupNotificationUrl!,
              banLookupAppIds: config.banLookupAppIds ?? [],
            },
      );
    }
  }

  async deliverQueuedWebhook(
    delivery: WebhookProxyDeliveryEnvelope,
  ): Promise<WebhookProxyDeliveryResult> {
    if (await this.isGuildSuspended?.(delivery.config.guildId)) return { status: "complete" };
    if (!(await this.isPaidGuild(delivery.config.guildId))) return { status: "complete" };
    const outcomes = await Promise.all(
      delivery.destinations.map((destination) =>
        this.forwardWithRetry(delivery.config, destination, delivery.body, delivery.contentType),
      ),
    );
    return combineWebhookDeliveryResults(outcomes);
  }

  private async isPaidGuild(guildId: string): Promise<boolean> {
    if (!this.guildEntitlements) return true;
    const entitlement = await this.guildEntitlements.readGuildEntitlement(guildId);
    return getGuildEntitlementLimits(entitlement.tier).paidFeatures;
  }

  invalidateWebhookProxyConfig(publicId: string): void {
    this.configCache.delete(publicId);
    this.eligibleConfigCache.delete(publicId);
  }

  private readEligibleWebhookProxyConfig(
    publicId: string,
  ): Promise<CachedWebhookProxyConfig | null> {
    const existing = this.eligibleConfigCache.get(publicId);
    if (existing) return existing;
    const promise = this.readCachedWebhookProxyConfig(publicId)
      .then(async (config) => {
        if (!config) return null;
        if (await this.isGuildSuspended?.(config.source.guildId)) return null;
        return (await this.isPaidGuild(config.source.guildId)) ? config : null;
      })
      .catch((error) => {
        this.eligibleConfigCache.delete(publicId);
        throw error;
      });
    this.eligibleConfigCache.set(publicId, promise);
    return promise;
  }

  private readCachedWebhookProxyConfig(publicId: string): Promise<CachedWebhookProxyConfig | null> {
    const existing = this.getCachedWebhookProxyConfig(publicId);
    if (existing) return existing.promise;

    const promise = this.store
      .readWebhookProxyConfig(publicId)
      .then((config) => {
        if (!config?.enabled) return null;
        return createCachedWebhookProxyConfig(config);
      })
      .catch((error) => {
        this.configCache.delete(publicId);
        throw error;
      });

    while (this.configCache.size >= WEBHOOK_PROXY_CONFIG_CACHE_MAX_ENTRIES) {
      const oldest = this.configCache.keys().next().value;
      if (oldest === undefined) break;
      this.configCache.delete(oldest);
    }
    this.configCache.set(publicId, {
      expiresAtMs: Date.now() + WEBHOOK_PROXY_CONFIG_CACHE_TTL_MS,
      promise,
    });
    return promise;
  }

  private getCachedWebhookProxyConfig(publicId: string): CachedWebhookProxyConfigEntry | null {
    const existing = this.configCache.get(publicId);
    if (!existing) return null;
    if (existing.expiresAtMs <= Date.now()) {
      this.configCache.delete(publicId);
      return null;
    }
    this.configCache.delete(publicId);
    this.configCache.set(publicId, existing);
    return existing;
  }

  private async forwardWithRetry(
    config: WebhookProxyDeliveryConfig,
    destination: WebhookProxyDestination | WebhookDeliveryTargetRef,
    body: string,
    contentType: string | null,
  ): Promise<WebhookProxyDeliveryResult> {
    let resolved: { url: string; destinationId: string; fingerprint: string | null };
    try {
      resolved = await this.resolveDeliveryTarget(config, destination);
    } catch (error) {
      if (error instanceof WebhookCredentialStoreUnavailableError) {
        return { status: "retry", reasonCode: "credential_store_unavailable" };
      }
      await this.recordWebhookFailure(
        config,
        destinationIdOf(destination),
        "credential_unavailable",
      );
      return { status: "terminal", reasonCode: "credential_unavailable" };
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(resolved.url, {
          method: "POST",
          headers: {
            "content-type": contentType?.trim() || "application/json",
          },
          body,
        });

        await this.logAttempt(config, resolved, {
          status: response.status,
          ok: response.ok,
          attempt,
          error: response.ok ? null : `HTTP ${response.status}`,
        });

        if (response.ok) {
          await this.recordWebhookHealthy(config, resolved.destinationId);
          return { status: "complete" };
        }

        if (attempt >= this.maxAttempts || !shouldRetryStatus(response.status)) {
          if (!shouldRetryStatus(response.status)) {
            const reasonCode =
              response.status === 404 ? "discord_webhook_not_found" : "provider_rejected";
            await this.recordWebhookFailure(
              config,
              resolved.destinationId,
              reasonCode,
              response.status,
            );
            return { status: "terminal", reasonCode };
          }
          await this.recordWebhookFailure(
            config,
            resolved.destinationId,
            response.status === 429 ? "provider_rate_limited" : "provider_unavailable",
            response.status,
          );
          return {
            status: "retry",
            reasonCode: response.status === 429 ? "provider_rate_limited" : "provider_unavailable",
            ...(response.status === 429
              ? { delaySeconds: Math.ceil(getRetryDelayMs(response, attempt) / 1_000) }
              : {}),
          };
        }

        await this.sleep(getRetryDelayMs(response, attempt));
      } catch {
        await this.logAttempt(config, resolved, {
          status: null,
          ok: false,
          attempt,
          error: "Network failure",
        });

        if (attempt >= this.maxAttempts) {
          await this.recordWebhookFailure(config, resolved.destinationId, "provider_network_error");
          return { status: "retry", reasonCode: "provider_network_error" };
        }

        await this.sleep(getExponentialDelayMs(attempt));
      }
    }
    return { status: "retry", reasonCode: "provider_unavailable" };
  }

  private async resolveDeliveryTarget(
    config: WebhookProxyDeliveryConfig,
    destination: WebhookProxyDestination | WebhookDeliveryTargetRef,
  ): Promise<{ url: string; destinationId: string; fingerprint: string | null }> {
    if ("credentialId" in destination) {
      if (!this.credentialService) throw new Error("Credential service unavailable");
      const resolved = await this.credentialService.resolve(destination.credentialId, {
        kind: "proxy_destination",
        guildId: config.guildId,
        publicId: config.publicId,
        destinationId: destination.destinationId,
      });
      return {
        url: resolved.url,
        destinationId: destination.destinationId,
        fingerprint: resolved.fingerprint,
      };
    }
    return { url: destination.url, destinationId: destination.id, fingerprint: null };
  }

  private async logAttempt(
    config: WebhookProxyDeliveryConfig,
    destination: { destinationId: string; fingerprint: string | null },
    details: Pick<WebhookProxyForwardLog, "status" | "ok" | "attempt" | "error">,
  ): Promise<void> {
    if (!this.persistDeliveryLogs) {
      return;
    }

    await this.store.createWebhookProxyForwardLog({
      guildId: config.guildId,
      id: createLogId(),
      publicId: config.publicId,
      destinationId: destination.destinationId,
      credentialFingerprint: destination.fingerprint,
      status: details.status,
      ok: details.ok,
      attempt: details.attempt,
      error: truncate(details.error, 500),
      timestampMs: Date.now(),
    });
  }

  private async recordWebhookFailure(
    config: WebhookProxyDeliveryConfig,
    destinationId: string,
    reasonCode: string,
    status?: number,
  ): Promise<void> {
    if (!this.operationalIncidents) return;
    try {
      const recent = await this.store.listWebhookProxyForwardLogs(
        config.guildId,
        config.publicId,
        100,
      );
      const cutoff = Date.now() - 15 * 60_000;
      const consecutiveFailureCount = recent.filter(
        (log) =>
          log.destinationId === destinationId &&
          !log.ok &&
          log.timestampMs >= cutoff &&
          (log.attempt >= this.maxAttempts ||
            (log.status !== null && !shouldRetryStatus(log.status))),
      ).length;
      const immediate = [
        "credential_missing",
        "credential_decrypt_failed",
        "destination_invalid",
        "discord_webhook_not_found",
        "credential_unavailable",
      ].includes(reasonCode);
      if (!immediate && consecutiveFailureCount < 3) return;
      await this.operationalIncidents.observeFailure({
        guildId: config.guildId,
        key: {
          feature: "webhooks",
          resourceKind: "destination",
          resourceId: destinationId,
          condition: "delivery-failing",
        },
        observationId: `webhook-terminal:${config.publicId}:${destinationId}:${Date.now()}`,
        severity: immediate ? "error" : "warning",
        summaryCode: "webhook_destination_delivery_failing",
        safeArgs: {
          publicId: config.publicId,
          destinationId,
          failureReasonCode: normalizeWebhookFailureCode(reasonCode),
          consecutiveFailureCount: Math.max(consecutiveFailureCount, 1),
          lastStatusFamily: statusFamily(status),
        },
        remediationCode: "review_webhook_destination",
      });
    } catch (error) {
      console.error("Webhook operational incident projection failed", {
        reasonCode: "incident_projection_failed",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private async recordWebhookHealthy(
    config: WebhookProxyDeliveryConfig,
    destinationId: string,
  ): Promise<void> {
    try {
      await this.operationalIncidents?.observeHealthy({
        guildId: config.guildId,
        key: {
          feature: "webhooks",
          resourceKind: "destination",
          resourceId: destinationId,
          condition: "delivery-failing",
        },
      });
    } catch (error) {
      console.error("Webhook operational incident recovery projection failed", {
        reasonCode: "incident_projection_failed",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

function combineWebhookDeliveryResults(
  outcomes: readonly WebhookProxyDeliveryResult[],
): WebhookProxyDeliveryResult {
  const retry = outcomes.find((outcome) => outcome.status === "retry");
  if (retry) return retry;
  const terminal = outcomes.find((outcome) => outcome.status === "terminal");
  return terminal ?? { status: "complete" };
}

function destinationIdOf(destination: WebhookProxyDestination | WebhookDeliveryTargetRef): string {
  return "destinationId" in destination ? destination.destinationId : destination.id;
}

function statusFamily(status: number | undefined): "2xx" | "4xx" | "5xx" | "network" | "unknown" {
  if (status === undefined) return "unknown";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "unknown";
}

function normalizeWebhookFailureCode(
  reasonCode: string,
):
  | "credential_missing"
  | "credential_decrypt_failed"
  | "destination_invalid"
  | "discord_webhook_not_found"
  | "provider_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_network_error"
  | "credential_unavailable"
  | "unknown" {
  const allowed = new Set([
    "credential_missing",
    "credential_decrypt_failed",
    "destination_invalid",
    "discord_webhook_not_found",
    "provider_rejected",
    "provider_rate_limited",
    "provider_unavailable",
    "provider_network_error",
    "credential_unavailable",
  ]);
  return allowed.has(reasonCode)
    ? (reasonCode as ReturnType<typeof normalizeWebhookFailureCode>)
    : "unknown";
}

export function selectDestinations(
  config: WebhookProxyConfig,
  body: string,
): WebhookProxyDestination[] {
  return selectDestinationsFromCachedConfig(createCachedWebhookProxyConfig(config), body);
}

export function evaluateWebhookProxyPayload(
  config: WebhookProxyConfig,
  body: string,
  contentType: string | null,
): WebhookProxyPayloadEvaluation {
  return evaluateCachedWebhookProxyPayload(
    createCachedWebhookProxyConfig(config),
    body,
    contentType,
  );
}

function createCachedWebhookProxyConfig(config: WebhookProxyConfig): CachedWebhookProxyConfig {
  return {
    source: config,
    destinationsById: new Map(
      config.destinations.map((destination) => [destination.id, destination]),
    ),
    compiledRules: config.routingRules.flatMap((rule) => {
      try {
        return [
          {
            source: rule,
            destinationIds: rule.destinationIds,
            matcher: new RegExp(rule.pattern, rule.flags),
          },
        ];
      } catch {
        // Rules are validated before storage; ignore stale invalid rules defensively.
        return [];
      }
    }),
    compiledReplacements: (config.contentReplacements ?? []).flatMap((replacement) => {
      try {
        return [
          {
            matcher: new RegExp(replacement.pattern, replacement.flags),
            replacement: replacement.replacement,
          },
        ];
      } catch {
        return [];
      }
    }),
  };
}

function selectDestinationsFromCachedConfig(
  config: CachedWebhookProxyConfig,
  body: string,
): WebhookProxyDestination[] {
  return matchDestinationsFromCachedConfig(config, body).destinations;
}

function evaluateCachedWebhookProxyPayload(
  config: CachedWebhookProxyConfig,
  body: string,
  contentType: string | null,
): WebhookProxyPayloadEvaluation {
  const transformedBody = applyContentReplacements(config.compiledReplacements, body, contentType);
  const routing = matchDestinationsFromCachedConfig(config, transformedBody);
  return {
    transformedBody,
    matchedRules: routing.matchedRules,
    destinations: routing.destinations,
    usedDefaultDestinations: routing.matchedRules.length === 0,
    steamIds: config.source.banLookupEnabled ? extractSteamIdsFromBody(transformedBody) : [],
  };
}

function matchDestinationsFromCachedConfig(
  config: CachedWebhookProxyConfig,
  body: string,
): {
  matchedRules: WebhookProxyConfig["routingRules"];
  destinations: WebhookProxyDestination[];
} {
  const selectedIds = new Set<string>();
  const matchedRules: WebhookProxyConfig["routingRules"] = [];

  for (const rule of config.compiledRules) {
    rule.matcher.lastIndex = 0;
    if (!rule.matcher.test(body)) {
      continue;
    }
    matchedRules.push(rule.source);
    for (const destinationId of rule.destinationIds) {
      selectedIds.add(destinationId);
    }
  }

  if (matchedRules.length === 0) {
    for (const destinationId of config.source.defaultDestinationIds) {
      selectedIds.add(destinationId);
    }
  }

  return {
    matchedRules,
    destinations: [...selectedIds]
      .map((destinationId) => config.destinationsById.get(destinationId))
      .filter((destination): destination is WebhookProxyDestination => Boolean(destination)),
  };
}

function applyContentReplacements(
  replacements: readonly CachedWebhookProxyContentReplacement[],
  body: string,
  contentType: string | null,
): string {
  if (contentType?.startsWith("application/json")) {
    const parsed = JSON.parse(body);
    if (replacements.length === 0) return body;
    const transformed = walkAndReplace(parsed, replacements);
    return JSON.stringify(transformed);
  }

  if (replacements.length === 0) return body;

  return replaceAll(body, replacements);
}

function replaceAll(
  input: string,
  replacements: readonly CachedWebhookProxyContentReplacement[],
): string {
  let result = input;
  for (const replacement of replacements) {
    result = result.replace(replacement.matcher, replacement.replacement);
  }
  return result;
}

function walkAndReplace(
  value: unknown,
  replacements: readonly CachedWebhookProxyContentReplacement[],
): unknown {
  if (typeof value === "string") {
    return replaceAll(value, replacements);
  }

  if (Array.isArray(value)) {
    return value.map((element) => walkAndReplace(element, replacements));
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = walkAndReplace(val, replacements);
    }
    return result;
  }

  return value;
}
function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelayMs(response: Response, attempt: number): number {
  if (response.status === 429) {
    const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "1");
    return Math.min((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 250, 25_000);
  }

  return getExponentialDelayMs(attempt);
}

function getExponentialDelayMs(attempt: number): number {
  return Math.min(2 ** (attempt - 1) * 500, 25_000);
}

function createLogId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function truncate(value: string | null, maxLength: number): string | null {
  if (value === null || value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength);
}
