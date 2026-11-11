import type { QueueBatch } from "../../../../../src/runtime/queue-types";
import type { Env } from "../../../test-env";
import { createBillingCatalog } from "../../../../../src/runtime/billing/catalog";
import { createBillingCheckoutService } from "../../../../../src/runtime/billing/checkout";
import { SqliteBillingSyncStore } from "./sqlite-billing-sync-store";
import { SqliteBillingWebhookStore } from "./sqlite-webhook-store";
import {
  createBillingOwnerSync,
  reconcileAllBillingOwners,
} from "../../../../../src/runtime/billing/owner-sync";
import {
  processBillingSyncMessage,
  sweepBillingSyncOutbox,
} from "../../../../../src/runtime/billing/sync-queue";
import { StripeHttpClient } from "../../../../../src/runtime/billing/stripe-http-client";
import {
  createStripeWebhookHandler,
  type BillingSyncQueueMessage,
} from "../../../../../src/runtime/billing/webhook";
import { SqliteBillingAssignmentStore } from "./sqlite-assignment-store";
import { SqliteBillingManagementStore } from "./sqlite-management-store";
import { createBillingManagementService } from "../../../../../src/runtime/billing/management";
import { SqliteBillingGraceStore } from "./sqlite-grace-store";
import { createBillingGraceProcessor } from "../../../../../src/runtime/billing/grace";
import { isRecord } from "../../../../../src/unknown-parse";
import { SqliteBillingHistoryStore } from "./history";
import { SqliteBillingSupportStore } from "./sqlite-support-store";
import { SqliteBillingDeliveryStore } from "./sqlite-delivery-store";
import { createBillingSupportService } from "../../../../../src/runtime/billing/support";
import { createBillingAdverseService } from "../../../../../src/runtime/billing/adverse";
import { SqliteBillingAdverseStore } from "./sqlite-adverse-store";
import { createLandingPriceCatalog } from "../../../../../src/runtime/billing/landing-catalog";
import { resolveBillingOwnerIdentity } from "./sqlite-owner-identity";

export const BILLING_SYNC_QUEUE_NAME = "haf-bot-billing-sync";

export function createSqliteBillingRuntime(env: Env) {
  const config = readBillingConfig(env);
  if (!config || !env.HAF_DB || !env.BILLING_SYNC_QUEUE) return null;
  const syncStore = new SqliteBillingSyncStore(env.HAF_DB);
  const webhookStore = new SqliteBillingWebhookStore(env.HAF_DB);
  const stripe = new StripeHttpClient(
    config.secretKey,
    config.apiVersion,
    config.portalConfigurationId,
  );
  const syncOwner = createBillingOwnerSync({
    stripe,
    store: syncStore,
    catalog: config.catalog,
    resolveOwnerIdentity: env.HAF_DB
      ? (ownerId) => resolveBillingOwnerIdentity(env.HAF_DB!, ownerId)
      : undefined,
    billingUrl: `${config.publicBaseUrl}/admin/billing`,
  });
  const queue = env.BILLING_SYNC_QUEUE;
  const adverse = createBillingAdverseService({
    provider: stripe,
    store: new SqliteBillingAdverseStore(env.HAF_DB),
    readEvent: (eventId) => webhookStore.readEvent(eventId),
  });
  const managementService = createBillingManagementService({
    provider: stripe,
    store: new SqliteBillingManagementStore(env.HAF_DB),
    catalog: config.catalog,
    publicBaseUrl: config.publicBaseUrl,
    syncOwner,
  });
  const assignmentStore = new SqliteBillingAssignmentStore(env.HAF_DB);
  return {
    landingPriceCatalog: createLandingPriceCatalog({
      catalog: config.catalog,
      stripe,
    }),
    webhookHandler: createStripeWebhookHandler({
      secret: config.webhookSecret,
      store: webhookStore,
      queue,
      customerResolver: stripe,
    }),
    sweepOutbox: () => sweepBillingSyncOutbox({ store: webhookStore, queue }),
    reconcileAllOwners: () =>
      reconcileAllBillingOwners({
        listOwnerIds: () => syncStore.listBoundOwnerIds(),
        syncOwner,
      }),
    checkoutService: createBillingCheckoutService({
      provider: stripe,
      store: syncStore,
      catalog: config.catalog,
      publicBaseUrl: config.publicBaseUrl,
      syncOwner,
    }),
    assignmentStore,
    managementService,
    processGrace: createBillingGraceProcessor({
      store: new SqliteBillingGraceStore(env.HAF_DB),
      syncOwner,
    }),
    historyStore: new SqliteBillingHistoryStore(env.HAF_DB),
    supportService: createBillingSupportService({
      store: new SqliteBillingSupportStore(env.HAF_DB),
      assignments: assignmentStore,
      delivery: new SqliteBillingDeliveryStore(env.HAF_DB),
      syncOwner,
      createBillingLink: (ownerId, intentId) => managementService.createPortal(ownerId, intentId),
    }),
    processMessage: (message: BillingSyncQueueMessage, attempts: number) =>
      processBillingSyncMessage({
        message,
        attempts,
        store: webhookStore,
        syncOwner,
        handleAdverseEvent: (eventId, ownerId) => adverse.handleEvent(eventId, ownerId),
      }),
  };
}

function readBillingConfig(env: Env) {
  const values = [
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.STRIPE_API_VERSION,
    env.STRIPE_PORTAL_CONFIGURATION_ID,
    env.STRIPE_PREMIUM_MONTHLY_PRICE_ID,
    env.STRIPE_PREMIUM_PRODUCT_ID,
    env.STRIPE_PREMIUM_YEARLY_PRICE_ID,
    env.STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID,
    env.STRIPE_PREMIUM_PLUS_PRODUCT_ID,
    env.STRIPE_PREMIUM_PLUS_YEARLY_PRICE_ID,
    env.BETTER_AUTH_URL,
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) return null;
  return {
    secretKey: env.STRIPE_SECRET_KEY!,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
    apiVersion: env.STRIPE_API_VERSION!,
    portalConfigurationId: env.STRIPE_PORTAL_CONFIGURATION_ID!,
    publicBaseUrl: env.BETTER_AUTH_URL!.replace(/\/$/, ""),
    catalog: createBillingCatalog({
      premiumMonthlyPriceId: env.STRIPE_PREMIUM_MONTHLY_PRICE_ID!,
      premiumMonthlyProductId: env.STRIPE_PREMIUM_PRODUCT_ID!,
      premiumYearlyPriceId: env.STRIPE_PREMIUM_YEARLY_PRICE_ID!,
      premiumYearlyProductId: env.STRIPE_PREMIUM_PRODUCT_ID!,
      premiumPlusMonthlyPriceId: env.STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID!,
      premiumPlusMonthlyProductId: env.STRIPE_PREMIUM_PLUS_PRODUCT_ID!,
      premiumPlusYearlyPriceId: env.STRIPE_PREMIUM_PLUS_YEARLY_PRICE_ID!,
      premiumPlusYearlyProductId: env.STRIPE_PREMIUM_PLUS_PRODUCT_ID!,
    }),
  };
}

export async function handleBillingSyncQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
): Promise<void> {
  const runtime = createSqliteBillingRuntime(env);
  if (!runtime) throw new Error("Billing sync Queue is not fully configured.");
  for (const message of batch.messages) {
    if (!isBillingSyncMessage(message.body)) {
      message.ack();
      continue;
    }
    const result = await runtime.processMessage(message.body, message.attempts);
    if (result === "retry") message.retry();
    else message.ack();
  }
}

function isBillingSyncMessage(value: unknown): value is BillingSyncQueueMessage {
  return (
    isRecord(value) && typeof value.eventId === "string" && typeof value.customerId === "string"
  );
}
