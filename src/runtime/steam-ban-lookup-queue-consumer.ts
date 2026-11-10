import type { QueueBatch } from "./queue-types";
import type { Env } from "../env";
import {
  SteamBanLookupService,
  type SteamBanLookupMessage,
  type SteamBanLookupProcessResult,
} from "../services/steam-ban-lookup-service";
import { createCloudflareSteamBanLookupStore } from "./cloudflare-steam-ban-lookup-store";
import { isRecord } from "../unknown-parse";
import { createCloudflareContext } from "./cloudflare-context";
import type { SteamBanLookupQueueMessage } from "../services/webhook-proxy-service";
import {
  WebhookCredentialStoreUnavailableError,
  type WebhookCredentialService,
} from "../security/webhook-credentials/store";
import {
  classifyQueueDeliveryError,
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  deliverQueueBatch,
  queueDeliveryEmitter,
} from "./queue-delivery";

export const STEAM_BAN_LOOKUP_QUEUE_NAME = "haf-bot-steam-ban-lookups";

export interface SteamBanLookupQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function handleSteamBanLookupQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: SteamBanLookupQueueLogger = console,
  credentialService?: WebhookCredentialService,
): Promise<void> {
  if (!env.STEAM_BAN_LOOKUP_KV) {
    logger.error("Steam ban lookup KV binding is missing");
    await deliverSteamBanLookupQueueBatch(batch, null, logger, credentialService);
    return;
  }

  const recheckIntervalMs = parsePositiveInteger(env.STEAM_BAN_LOOKUP_RECHECK_INTERVAL_MS);
  const store = createCloudflareSteamBanLookupStore(
    env.STEAM_BAN_LOOKUP_KV,
    msToTtlSeconds(recheckIntervalMs),
  );
  const service = new SteamBanLookupService({
    steamWebApiKey: env.STEAM_WEB_API_KEY,
    store,
    recheckIntervalMs,
    logger,
  });

  const context = createCloudflareContext(env);
  await deliverSteamBanLookupQueueBatch(
    batch,
    service,
    logger,
    credentialService ?? context.webhookCredentialService,
  );
}

export async function deliverSteamBanLookupQueueBatch(
  batch: QueueBatch<unknown>,
  service: {
    processBatch(messages: SteamBanLookupMessage[]): Promise<SteamBanLookupProcessResult>;
  } | null,
  logger: SteamBanLookupQueueLogger = console,
  credentialService?: WebhookCredentialService,
): Promise<void> {
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
    parse(body) {
      const message = parseSteamBanLookupMessage(body);
      return message
        ? { ok: true, value: message }
        : { ok: false, reasonCode: "invalid_steam_lookup" };
    },
    async handle(message) {
      if (!service) return { status: "terminal", reasonCode: "missing_kv_binding" };
      if ("notificationCredentialId" in message) {
        if (!credentialService) {
          return { status: "terminal", reasonCode: "credential_unavailable" };
        }
        try {
          const credential = await credentialService.resolve(message.notificationCredentialId, {
            kind: "ban_lookup_notification",
            guildId: message.guildId,
            publicId: message.publicId,
          });
          return service.processBatch([
            {
              guildId: message.guildId,
              steamIds: message.steamIds,
              notificationUrl: credential.url,
              banLookupAppIds: message.banLookupAppIds,
            },
          ]);
        } catch (error) {
          if (error instanceof WebhookCredentialStoreUnavailableError) {
            return { status: "retry", reasonCode: "credential_store_unavailable" };
          }
          return { status: "terminal", reasonCode: "credential_unavailable" };
        }
      }
      return service.processBatch([message]);
    },
    classifyError: classifyQueueDeliveryError,
    emit: queueDeliveryEmitter(logger),
  });
}

function parseSteamBanLookupMessage(message: unknown): SteamBanLookupQueueMessage | null {
  if (
    !isRecord(message) ||
    !Array.isArray(message.steamIds) ||
    !Array.isArray(message.banLookupAppIds)
  ) {
    return null;
  }

  const guildId = asString(message.guildId);
  const notificationUrl = asString(message.notificationUrl);
  const publicId = asString(message.publicId);
  const notificationCredentialId = asString(message.notificationCredentialId);
  const steamIds = message.steamIds.filter((value): value is string => typeof value === "string");
  const banLookupAppIds = message.banLookupAppIds.filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value),
  );

  if (!guildId || steamIds.length === 0) return null;
  if (message.version === 2) {
    if (!publicId || !notificationCredentialId) return null;
    return {
      version: 2,
      guildId,
      publicId,
      steamIds,
      notificationCredentialId,
      banLookupAppIds,
    };
  }
  if (!notificationUrl || !notificationUrl.startsWith("https://")) return null;
  return { version: 1, guildId, steamIds, notificationUrl, banLookupAppIds };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function msToTtlSeconds(ms: number | undefined): number {
  if (!ms) {
    return 24 * 60 * 60;
  }
  return Math.max(60, Math.ceil(ms / 1000));
}
