import type { PostgresDatabaseCapability } from "../postgres/postgres-capability";
import type { QueueBatch } from "../queue-types";
import type { Env } from "../../env";
import { createBillingCatalog } from "./catalog";
import { createBillingCheckoutService } from "./checkout";
import { PostgresBillingSyncStore } from "../postgres/postgres-billing-sync-store";
import { PostgresBillingWebhookStore } from "../postgres/postgres-billing-webhook-store";
import { createBillingOwnerSync, reconcileAllBillingOwners } from "./owner-sync";
import { processBillingSyncMessage, sweepBillingSyncOutbox } from "./sync-queue";
import { StripeHttpClient } from "./stripe-http-client";
import { createStripeWebhookHandler, type BillingSyncQueueMessage } from "./webhook";
import { PostgresBillingAssignmentStore } from "../postgres/postgres-billing-assignment-store";
import { PostgresBillingManagementStore } from "../postgres/postgres-billing-management-store";
import { createBillingManagementService } from "./management";
import { PostgresBillingGraceStore } from "../postgres/postgres-billing-grace-store";
import { createBillingGraceProcessor } from "./grace";
import { isRecord } from "../../unknown-parse";
import { PostgresBillingHistoryStore } from "../postgres/postgres-billing-history";
import { PostgresBillingSupportStore } from "../postgres/postgres-billing-support-store";
import { PostgresBillingDeliveryStore } from "../postgres/postgres-billing-delivery-store";
import { createBillingSupportService } from "./support";
import { createBillingAdverseService } from "./adverse";
import { PostgresBillingAdverseStore } from "../postgres/postgres-billing-adverse-store";
import { createLandingPriceCatalog } from "./landing-catalog";
import { resolveBillingOwnerIdentity } from "../postgres/postgres-billing-owner-identity";

export const BILLING_SYNC_QUEUE_NAME = "haf-bot-billing-sync";

export function createPostgresBillingRuntime(env: Env, database: PostgresDatabaseCapability) {
  const config = readBillingConfig(env);
  if (!config || !env.BILLING_SYNC_QUEUE) return null;
  const syncStore = new PostgresBillingSyncStore(database);
  const webhookStore = new PostgresBillingWebhookStore(database);
  const stripe = new StripeHttpClient(
    config.secretKey,
    config.apiVersion,
    config.portalConfigurationId,
  );
  const syncOwner = createBillingOwnerSync({
    stripe,
    store: syncStore,
    catalog: config.catalog,
    resolveOwnerIdentity: (ownerId) => resolveBillingOwnerIdentity(database, ownerId),
    billingUrl: `${config.publicBaseUrl}/admin/billing`,
  });
  const queue = env.BILLING_SYNC_QUEUE;
  const adverse = createBillingAdverseService({
    provider: stripe,
    store: new PostgresBillingAdverseStore(database),
    readEvent: (eventId) => webhookStore.readEvent(eventId),
  });
  const managementService = createBillingManagementService({
    provider: stripe,
    store: new PostgresBillingManagementStore(database),
    catalog: config.catalog,
    publicBaseUrl: config.publicBaseUrl,
    syncOwner,
  });
  const assignmentStore = new PostgresBillingAssignmentStore(database);
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
      store: new PostgresBillingGraceStore(database),
      syncOwner,
    }),
    historyStore: new PostgresBillingHistoryStore(database),
    supportService: createBillingSupportService({
      store: new PostgresBillingSupportStore(database),
      assignments: assignmentStore,
      delivery: new PostgresBillingDeliveryStore(database),
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
  database: PostgresDatabaseCapability,
): Promise<void> {
  const runtime = createPostgresBillingRuntime(env, database);
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
