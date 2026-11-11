import type { PostgresDatabaseCapability } from "../postgres/postgres-capability";
import type { QueueBatch } from "../queue-types";
import type { Env } from "../../env";
import { DiscordApiError } from "../../discord/client";
import {
  createChannelMessage,
  createUserDmMessage,
  suppressMentions,
} from "../../discord/messages";
import {
  BillingDeliveryError,
  processBillingDelivery,
  sweepBillingDeliveryOutbox,
} from "./delivery";
import { PostgresBillingDeliveryStore } from "../postgres/postgres-billing-delivery-store";
import { resolveBillingOwnerIdentity } from "../postgres/postgres-billing-owner-identity";
import { isRecord } from "../../unknown-parse";

export const BILLING_DELIVERY_QUEUE_NAME = "haf-bot-billing-delivery";

export function createPostgresBillingDeliveryRuntime(
  env: Env,
  database: PostgresDatabaseCapability,
) {
  if (!env.BILLING_DELIVERY_QUEUE || !env.BILLING_AUDIT_CHANNEL_ID) return null;
  const store = new PostgresBillingDeliveryStore(database);
  const discord = {
    async resolveOwnerDiscordIdentity(ownerId: string) {
      return resolveBillingOwnerIdentity(database, ownerId);
    },
    async sendOwnerDm(discordUserId: string, message: Parameters<typeof createUserDmMessage>[1]) {
      try {
        return await createUserDmMessage(
          discordUserId,
          { ...message, allowed_mentions: suppressMentions() },
          env.DISCORD_BOT_TOKEN,
        );
      } catch (error) {
        throw classifyDiscordError(error);
      }
    },
    async sendAudit(message: Parameters<typeof createChannelMessage>[1]) {
      try {
        return await createChannelMessage(
          env.BILLING_AUDIT_CHANNEL_ID!,
          { ...message, allowed_mentions: suppressMentions() },
          env.DISCORD_BOT_TOKEN,
        );
      } catch (error) {
        throw classifyDiscordError(error);
      }
    },
  };
  return {
    sweep: () => sweepBillingDeliveryOutbox({ store, queue: env.BILLING_DELIVERY_QUEUE! }),
    process: (operationId: string) => processBillingDelivery({ operationId, store, discord }),
    store,
  };
}

export async function handleBillingDeliveryQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  database: PostgresDatabaseCapability,
) {
  const runtime = createPostgresBillingDeliveryRuntime(env, database);
  if (!runtime) throw new Error("Billing delivery Queue is not fully configured.");
  for (const message of batch.messages) {
    const operationId =
      isRecord(message.body) && typeof message.body.operationId === "string"
        ? message.body.operationId
        : null;
    if (!operationId) {
      message.ack();
      continue;
    }
    const result = await runtime.process(operationId);
    if (result.result === "retry") message.retry({ delaySeconds: result.delaySeconds });
    else message.ack();
  }
}

function classifyDiscordError(error: unknown): BillingDeliveryError {
  if (!(error instanceof DiscordApiError))
    return new BillingDeliveryError(
      error instanceof Error ? error.message : "discord_delivery_failed",
      true,
    );
  const transient = error.status === 429 || error.status >= 500;
  return new BillingDeliveryError(`discord_${error.status}`, transient, error.retryAfterMs);
}
