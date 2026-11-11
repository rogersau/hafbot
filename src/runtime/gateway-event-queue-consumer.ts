import type { QueueBatch } from "./queue-types";
import type { Env } from "../env";
import { isRecord } from "../unknown-parse";
import {
  classifyQueueDeliveryError,
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  deliverQueueBatch,
  queueDeliveryEmitter,
  type QueueParseResult,
  QueueTerminalError,
} from "./queue-delivery";
import {
  deriveGatewayEventKey,
  GATEWAY_EVENT_RECEIPT_RETENTION_MS,
  isValidGatewayEventKey,
} from "./gateway-event-idempotency";
import {
  createEnvelopeOperationRunner,
  createGatewayEventCapabilities,
  type GatewayEventDependencies,
} from "./gateway-events/capabilities";
import type { GatewayEventEnvelope, GatewayEventQueueLogger } from "./gateway-events/contracts";
import { dispatchRegisteredGatewayEvent } from "./gateway-events/registry";

export const GATEWAY_EVENT_QUEUE_NAME = "haf-bot-gateway-events";

const IDEMPOTENT_GATEWAY_EVENT_TYPES = new Set([
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "GUILD_MEMBER_ADD",
  "GUILD_MEMBER_UPDATE",
  "GUILD_MEMBER_REMOVE",
  "GUILD_BAN_ADD",
  "GUILD_BAN_REMOVE",
  "INVITE_CREATE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "GUILD_CREATE",
  "GUILD_DELETE",
  "VOICE_STATE_UPDATE",
]);

export type { GatewayEventEnvelope, GatewayEventQueueLogger } from "./gateway-events/contracts";

export async function handleGatewayEventQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: GatewayEventQueueLogger = console,
  dependencies: GatewayEventDependencies,
): Promise<void> {
  await deliverGatewayEventQueueBatch(batch, env, logger, dependencies);
}

export async function deliverGatewayEventQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  logger: GatewayEventQueueLogger = console,
  dependencies: GatewayEventDependencies,
): Promise<void> {
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
    parse: parseGatewayEventEnvelope,
    async handle(envelope) {
      await processGatewayEventEnvelope(envelope, env, logger, dependencies);
      return { status: "complete" };
    },
    classifyError: classifyQueueDeliveryError,
    emit: queueDeliveryEmitter(logger),
  });
  try {
    await dependencies.operationStore.cleanupCompletedBefore(
      Date.now() - GATEWAY_EVENT_RECEIPT_RETENTION_MS,
    );
  } catch {
    logger.error("Gateway Event receipt cleanup failed", {
      reasonCode: "database_unavailable",
    });
  }
}

export async function processGatewayEventQueueMessages(
  messages: unknown[],
  env: Env,
  logger: GatewayEventQueueLogger = console,
  dependencies: GatewayEventDependencies,
): Promise<void> {
  for (const message of messages) {
    const parsed = parseGatewayEventEnvelope(message);
    if (!parsed.ok) {
      logger.error("Skipping malformed gateway event queue message", {
        reasonCode: parsed.reasonCode,
      });
      continue;
    }

    try {
      await processGatewayEventEnvelope(parsed.value, env, logger, dependencies);
    } catch (error) {
      logger.error("Failed to process gateway event queue message", {
        reasonCode: classifyQueueDeliveryError(error).reasonCode,
      });
      throw error;
    }
  }
}

async function processGatewayEventEnvelope(
  envelope: GatewayEventEnvelope,
  env: Env,
  logger: GatewayEventQueueLogger = console,
  dependencies: GatewayEventDependencies,
): Promise<void> {
  if (env.discordE2eActors) {
    const data = isRecord(envelope.data) ? envelope.data : {};
    const guildId = ["GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"].includes(envelope.type)
      ? data.id
      : data.guild_id;
    if (guildId !== env.discordE2eActors.guildId) return;
    envelope = {
      ...envelope,
      data: env.discordE2eActors.view(
        envelope.data,
        guildId,
        envelope.botUserId ?? env.BOT_USER_ID,
      ),
    };
  }
  if (!IDEMPOTENT_GATEWAY_EVENT_TYPES.has(envelope.type)) {
    await processGatewayEventOperations(envelope, env, logger, dependencies);
    return;
  }
  const store = dependencies.operationStore;
  const receipt = await store.read(envelope.eventKey, "event:dispatch");
  if (receipt?.state === "terminal") {
    throw new QueueTerminalError(receipt.outcomeCode ?? "gateway_operation_terminal");
  }
  if (receipt?.state === "completed") {
    logger.info?.("gateway_event_idempotency", {
      event: "duplicate_suppressed",
      eventKey: envelope.eventKey,
      handlerKey: "event:dispatch",
      attempts: receipt.attempts,
    });
    return;
  }
  const eventReceipt = createEnvelopeOperationRunner(envelope, logger, dependencies.operationStore);
  try {
    await processGatewayEventOperations(envelope, env, logger, dependencies);
  } catch (error) {
    if (error instanceof QueueTerminalError) {
      await eventReceipt.run("event:dispatch", async () => {
        throw error;
      });
    }
    throw error;
  }
  await eventReceipt.run("event:dispatch", async () => {});
}

async function processGatewayEventOperations(
  envelope: GatewayEventEnvelope,
  env: Env,
  logger: GatewayEventQueueLogger,
  dependencies: GatewayEventDependencies,
): Promise<void> {
  const capabilities = await createGatewayEventCapabilities(envelope, env, logger, dependencies);
  if (!capabilities) return;
  await dispatchRegisteredGatewayEvent(capabilities, envelope, logger);
}

function parseGatewayEventEnvelope(message: unknown): QueueParseResult<GatewayEventEnvelope> {
  if (!isRecord(message) || typeof message.type !== "string" || !("data" in message)) {
    return { ok: false, reasonCode: "invalid_gateway_event" };
  }

  if (message.version !== 2) {
    return { ok: false, reasonCode: "unsupported_gateway_event_version" };
  }

  const expectedEventKey = deriveGatewayEventKey(message);
  const eventKey =
    typeof message.eventKey === "string" &&
    isValidGatewayEventKey(message.eventKey) &&
    message.eventKey === expectedEventKey
      ? message.eventKey
      : null;
  if (!eventKey) return { ok: false, reasonCode: "invalid_gateway_event_key" };

  return {
    ok: true,
    value: {
      version: 2,
      eventKey,
      ...(typeof message.receivedAtMs === "number" &&
      Number.isSafeInteger(message.receivedAtMs) &&
      message.receivedAtMs >= 0
        ? { receivedAtMs: message.receivedAtMs }
        : {}),
      sessionId: typeof message.sessionId === "string" ? message.sessionId : null,
      sequence:
        typeof message.sequence === "number" && Number.isSafeInteger(message.sequence)
          ? message.sequence
          : null,
      type: message.type,
      data: message.data,
      botIdentityId:
        typeof message.botIdentityId === "string"
          ? message.botIdentityId
          : message.botIdentityId === null
            ? null
            : undefined,
      botUserId:
        typeof message.botUserId === "string"
          ? message.botUserId
          : message.botUserId === null
            ? null
            : undefined,
      previousRoleIds: Array.isArray(message.previousRoleIds)
        ? message.previousRoleIds.filter((roleId): roleId is string => typeof roleId === "string")
        : message.previousRoleIds === null
          ? null
          : undefined,
      previousNick:
        typeof message.previousNick === "string"
          ? message.previousNick
          : message.previousNick === null
            ? null
            : undefined,
      emptiedVoiceChannelId:
        typeof message.emptiedVoiceChannelId === "string"
          ? message.emptiedVoiceChannelId
          : message.emptiedVoiceChannelId === null
            ? null
            : undefined,
    },
  };
}
