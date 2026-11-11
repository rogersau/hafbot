import type { PostgresDatabaseCapability } from "../postgres/postgres-capability";
import type { QueueJobMetadata } from "../queue-types";
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
import { deliverQueueJob, type QueueDeliveryOutcome } from "../queue-delivery";

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

export interface BillingDeliveryProcessingPort {
  process(operationId: string): Promise<{ result: "complete" | "retry"; delaySeconds?: number }>;
}

export async function deliverBillingDelivery(
  payload: unknown,
  metadata: QueueJobMetadata,
  processing: BillingDeliveryProcessingPort,
): Promise<QueueDeliveryOutcome> {
  return deliverQueueJob(payload, {
    metadata,
    parse(body) {
      const operationId =
        isRecord(body) && typeof body.operationId === "string" ? body.operationId : null;
      return operationId
        ? { ok: true, value: operationId }
        : { ok: false, reasonCode: "invalid_billing_delivery_message" };
    },
    async handle(operationId) {
      const result = await processing.process(operationId);
      return result.result === "retry"
        ? {
            status: "retry",
            reasonCode: "billing_delivery_retry",
            ...(result.delaySeconds === undefined ? {} : { delaySeconds: result.delaySeconds }),
          }
        : { status: "complete" };
    },
  });
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
