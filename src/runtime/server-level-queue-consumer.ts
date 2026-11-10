import type { QueueBatch } from "./queue-types";
import { fetchGuildMember } from "../discord/members";
import { createChannelMessage } from "../discord/messages";
import { DiscordApiError } from "../discord/client";
import type { Env } from "../env";
import type { ServerLevelIngressMessage } from "../server-levels/ingress";
import { sweepServerLevelIngressOutbox } from "../server-levels/ingress";
import { CftoolsDataApiClient } from "../server-levels/data-api";
import { ServerLevelProcessor } from "../server-levels/processor";
import { SERVER_LEVEL_ORDERING_WINDOW_MS } from "../server-levels/policy";
import { isRecord } from "../unknown-parse";
import {
  emitServerLevelTelemetry,
  logServerLevelTelemetry,
  type ServerLevelTelemetryEmitter,
} from "../server-levels/telemetry";
import { createCloudflareContext } from "./cloudflare-context";
import type { ServerLevelStore } from "./contracts/server-level-store";
import {
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  classifyQueueDeliveryError,
  deliverQueueBatch,
  queueDeliveryEmitter,
} from "./queue-delivery";

export const SERVER_LEVELS_QUEUE_NAME = "haf-bot-server-levels";
const ROSTER_RECONCILIATION_INTERVAL_MS = 30 * 60 * 1_000;
const CAPACITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface ServerLevelQueueLogger {
  error(...args: unknown[]): void;
  info?(...args: unknown[]): void;
}

export async function handleServerLevelQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: ServerLevelQueueLogger = console,
  now: () => number = Date.now,
): Promise<void> {
  const context = createCloudflareContext(env);
  const processor = createServerLevelProcessor(env, now, logServerLevelTelemetry);
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
    parse(body) {
      const message = parseServerLevelMessage(body);
      return message
        ? { ok: true, value: message }
        : { ok: false, reasonCode: "invalid_server_level_message" };
    },
    async handle(message) {
      const event = await context.stores.serverLevels.readProviderEvent(message.inboxId);
      if (!event || event.guildId !== message.guildId) {
        return { status: "terminal", reasonCode: "provider_event_missing" };
      }
      const currentTime = now();
      const eligibleAtMs =
        Math.max(event.receivedAtMs, event.occurredAtMs) + SERVER_LEVEL_ORDERING_WINDOW_MS;
      if (currentTime < eligibleAtMs) {
        return {
          status: "retry",
          reasonCode: "ordering_window_open",
          delaySeconds: Math.max(1, Math.ceil((eligibleAtMs - currentTime) / 1_000)),
        };
      }
      await processor.processAvailableForServer(event.configuredGameServerId);
      return { status: "complete" };
    },
    classifyError: classifyQueueDeliveryError,
    emit: queueDeliveryEmitter(logger),
  });
}

export async function maintainServerLevels(
  env: Env,
  now: () => number = Date.now,
  emitTelemetry: ServerLevelTelemetryEmitter = logServerLevelTelemetry,
): Promise<{ published: number; servers: number }> {
  const context = createCloudflareContext(env);
  const published = env.SERVER_LEVELS_QUEUE
    ? await sweepServerLevelIngressOutbox({
        store: context.stores.serverLevels,
        queue: env.SERVER_LEVELS_QUEUE,
        now,
      })
    : 0;
  const processor = createServerLevelProcessor(env, now, emitTelemetry);
  const dataApi = context.serverLevelCredentialService
    ? new CftoolsDataApiClient({ credentials: context.serverLevelCredentialService, now })
    : null;
  let serverCount = 0;
  let after: { guildId: string; createdAtMs: number; id: string } | undefined;
  while (true) {
    const servers = await context.stores.serverLevels.listAllConfiguredGameServers(100, after);
    for (const server of servers) {
      await processor.processAvailableForServer(server.id);
      await processor.checkpointAvailableForServer(server.id, now());
      if (
        dataApi &&
        context.features.serverLevels !== false &&
        (server.lastRosterReconciledAtMs === null ||
          now() - server.lastRosterReconciledAtMs >= ROSTER_RECONCILIATION_INTERVAL_MS)
      ) {
        const [config, entitlement] = await Promise.all([
          context.stores.serverLevels.readConfig(server.guildId),
          context.stores.guildEntitlements.readGuildEntitlement(server.guildId),
        ]);
        if (
          config?.enabled === true &&
          config.removedAtMs === null &&
          entitlement.tier !== "free" &&
          (await context.serverLevelCredentialService!.hasDataApiCredential({
            guildId: server.guildId,
            configuredGameServerId: server.id,
          }))
        ) {
          const startedAtMs = now();
          let observation;
          try {
            observation = await dataApi.observeCurrentRoster(server);
          } catch {
            emitServerLevelTelemetry(emitTelemetry, {
              category: "reconciliation",
              outcome: "failed",
              durationMs: now() - startedAtMs,
              count: 0,
              reasonCode: "provider_unavailable_or_invalid",
            });
            continue;
          }
          try {
            await processor.reconcileCurrentRoster({
              configuredGameServerId: server.id,
              ...observation,
              checkCapacity:
                server.lastCapacityCheckedAtMs === null ||
                observation.observedAtMs - server.lastCapacityCheckedAtMs >=
                  CAPACITY_CHECK_INTERVAL_MS,
            });
          } catch {
            // The processor records a privacy-safe reconciliation failure and the next sweep retries.
          }
        }
      }
    }
    serverCount += servers.length;
    const last = servers.at(-1);
    if (!last || servers.length < 100) break;
    after = { guildId: last.guildId, createdAtMs: last.createdAtMs, id: last.id };
  }
  await deliverPendingLevelAnnouncements(env, context.stores.serverLevels, now, emitTelemetry);
  await context.stores.serverLevels.compactIntervalAwards(now() - 90 * 24 * 60 * 60 * 1_000, 25);
  await context.stores.serverLevels.purgeRemovedGuilds(now() - 30 * 24 * 60 * 60 * 1_000, 25);
  return { published, servers: serverCount };
}

export async function deliverPendingLevelAnnouncements(
  env: Pick<Env, "DISCORD_BOT_TOKEN">,
  store: ServerLevelStore,
  now: () => number,
  emitTelemetry: ServerLevelTelemetryEmitter,
  sendMessage: typeof createChannelMessage = createChannelMessage,
): Promise<void> {
  for (const announcement of await store.listPendingLevelAnnouncements(100)) {
    const startedAtMs = now();
    try {
      const nonce = await serverLevelAnnouncementNonce(announcement.announcementId);
      await sendMessage(
        announcement.channelId,
        {
          content: `🎉 <@${announcement.userId}> reached Server Level **${announcement.level}**!`,
          allowed_mentions: { parse: [], users: [announcement.userId] },
          nonce,
          enforce_nonce: true,
        },
        env.DISCORD_BOT_TOKEN,
      );
      await store.markLevelAnnouncementDelivered(announcement.announcementId, now());
      emitServerLevelTelemetry(emitTelemetry, {
        category: "discord_delivery",
        outcome: "delivered",
        durationMs: now() - startedAtMs,
      });
    } catch (error) {
      if (error instanceof DiscordApiError && (error.status === 403 || error.status === 404)) {
        await store.markLevelAnnouncementTerminal(
          announcement.announcementId,
          error.status === 403 ? "discord_permission_denied" : "announcement_channel_missing",
          now(),
        );
        emitServerLevelTelemetry(emitTelemetry, {
          category: "discord_delivery",
          outcome: "terminal",
          durationMs: now() - startedAtMs,
          reasonCode:
            error.status === 403 ? "discord_permission_denied" : "announcement_channel_missing",
        });
      } else {
        emitServerLevelTelemetry(emitTelemetry, {
          category: "discord_delivery",
          outcome: "retry",
          durationMs: now() - startedAtMs,
          reasonCode: "discord_delivery_failed",
        });
      }
    }
  }
}

async function serverLevelAnnouncementNonce(announcementId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(announcementId));
  return `sl_${Array.from(new Uint8Array(digest).slice(0, 8))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function createServerLevelProcessor(
  env: Env,
  now: () => number,
  emitTelemetry: ServerLevelTelemetryEmitter,
): ServerLevelProcessor {
  const context = createCloudflareContext(env);
  return new ServerLevelProcessor({
    store: context.stores.serverLevels,
    platformLinks: context.stores.platformLink,
    readEntitlementTier: async (guildId) =>
      (await context.stores.guildEntitlements.readGuildEntitlement(guildId)).tier,
    isCurrentGuildMember: async (guildId, userId) =>
      (await fetchGuildMember(guildId, userId, env.DISCORD_BOT_TOKEN)) !== null,
    isKillSwitchEnabled: () => context.features.serverLevels === false,
    now,
    emitTelemetry,
  });
}

function parseServerLevelMessage(value: unknown): ServerLevelIngressMessage | null {
  if (!isRecord(value)) return null;
  const inboxId = typeof value.inboxId === "string" ? value.inboxId.trim() : "";
  const guildId = typeof value.guildId === "string" ? value.guildId.trim() : "";
  if (!inboxId || !guildId || inboxId.length > 200 || guildId.length > 100) return null;
  return { inboxId, guildId };
}
