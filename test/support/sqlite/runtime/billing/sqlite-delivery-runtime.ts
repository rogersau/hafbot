import type { Env } from "../../../test-env";
import { DiscordApiError } from "../../../../../src/discord/client";
import {
  createChannelMessage,
  createUserDmMessage,
  suppressMentions,
} from "../../../../../src/discord/messages";
import {
  BillingDeliveryError,
  processBillingDelivery,
  sweepBillingDeliveryOutbox,
} from "../../../../../src/runtime/billing/delivery";
import { SqliteBillingDeliveryStore } from "./sqlite-delivery-store";
import { resolveBillingOwnerIdentity } from "./sqlite-owner-identity";

export const BILLING_DELIVERY_QUEUE_NAME = "haf-bot-billing-delivery";

export function createSqliteBillingDeliveryRuntime(env: Env) {
  if (!env.HAF_DB || !env.BILLING_DELIVERY_QUEUE || !env.BILLING_AUDIT_CHANNEL_ID) return null;
  const store = new SqliteBillingDeliveryStore(env.HAF_DB);
  const discord = {
    async resolveOwnerDiscordIdentity(ownerId: string) {
      return resolveBillingOwnerIdentity(env.HAF_DB!, ownerId);
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

export { deliverBillingDelivery } from "../../../../../src/runtime/billing/postgres-delivery-runtime";

function classifyDiscordError(error: unknown): BillingDeliveryError {
  if (!(error instanceof DiscordApiError))
    return new BillingDeliveryError(
      error instanceof Error ? error.message : "discord_delivery_failed",
      true,
    );
  const transient = error.status === 429 || error.status >= 500;
  return new BillingDeliveryError(`discord_${error.status}`, transient, error.retryAfterMs);
}
