import type { QueueJobMetadata } from "./queue-types";

import {
  type SteamBanLookupMessage,
  type SteamBanLookupProcessResult,
} from "../services/steam-ban-lookup-service";

import { isRecord } from "../unknown-parse";

import type { SteamBanLookupQueueMessage } from "../services/webhook-proxy-service";
import {
  WebhookCredentialStoreUnavailableError,
  type WebhookCredentialService,
} from "../security/webhook-credentials/store";
import {
  classifyQueueDeliveryError,
  deliverQueueJob,
  queueDeliveryEmitter,
  type QueueDeliveryOutcome,
} from "./queue-delivery";

export const STEAM_BAN_LOOKUP_QUEUE_NAME = "haf-bot-steam-ban-lookups";

export interface SteamBanLookupQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function deliverSteamBanLookup(
  payload: unknown,
  metadata: QueueJobMetadata,
  service: {
    processBatch(messages: SteamBanLookupMessage[]): Promise<SteamBanLookupProcessResult>;
  } | null,
  logger: SteamBanLookupQueueLogger = console,
  credentialService?: Pick<WebhookCredentialService, "resolve">,
): Promise<QueueDeliveryOutcome> {
  return deliverQueueJob(payload, {
    metadata,
    parse(body) {
      const message = parseSteamBanLookupMessage(body);
      return message
        ? { ok: true, value: message }
        : { ok: false, reasonCode: "invalid_steam_lookup" };
    },
    async handle(message) {
      if (!service) return { status: "terminal", reasonCode: "service_unavailable" };
      {
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
  const publicId = asString(message.publicId);
  const notificationCredentialId = asString(message.notificationCredentialId);
  const steamIds = message.steamIds.filter((value): value is string => typeof value === "string");
  const banLookupAppIds = message.banLookupAppIds.filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value),
  );

  if (!guildId || steamIds.length === 0) return null;
  if (message.version !== 2 || !publicId || !notificationCredentialId) return null;
  if (
    steamIds.length !== message.steamIds.length ||
    banLookupAppIds.length !== message.banLookupAppIds.length
  )
    return null;
  return { version: 2, guildId, publicId, steamIds, notificationCredentialId, banLookupAppIds };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
