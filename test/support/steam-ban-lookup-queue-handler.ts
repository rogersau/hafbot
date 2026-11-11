import type { QueueBatch } from "../../src/runtime/queue-types";
import type { Env } from "./test-env";
import { SteamBanLookupService } from "../../src/services/steam-ban-lookup-service";
import { createSqliteSteamBanLookupStore } from "./sqlite/runtime/sqlite-steam-ban-lookup-store";

import { createSqliteContext } from "./sqlite/runtime/sqlite-context";

import { type WebhookCredentialService } from "../../src/security/webhook-credentials/store";

import {
  deliverSteamBanLookupQueueBatch,
  type SteamBanLookupQueueLogger,
} from "../../src/runtime/steam-ban-lookup-queue-consumer";
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
  const store = createSqliteSteamBanLookupStore(
    env.STEAM_BAN_LOOKUP_KV,
    msToTtlSeconds(recheckIntervalMs),
  );
  const service = new SteamBanLookupService({
    steamWebApiKey: env.STEAM_WEB_API_KEY,
    store,
    recheckIntervalMs,
    logger,
  });

  const context = createSqliteContext(env);
  await deliverSteamBanLookupQueueBatch(
    batch,
    service,
    logger,
    credentialService ?? context.webhookCredentialService,
  );
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
export * from "../../src/runtime/steam-ban-lookup-queue-consumer";
