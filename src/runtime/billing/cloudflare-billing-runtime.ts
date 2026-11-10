import type { QueueBatch } from "../queue-types";
import type { Env } from "../../env";
import { createBillingCatalog } from "./catalog";
import { createBillingCheckoutService } from "./checkout";
import { CloudflareBillingSyncStore } from "./cloudflare-billing-sync-store";
import { CloudflareBillingWebhookStore } from "./cloudflare-webhook-store";
import { createBillingOwnerSync, reconcileAllBillingOwners } from "./owner-sync";
import { processBillingSyncMessage, sweepBillingSyncOutbox } from "./sync-queue";
import { StripeHttpClient } from "./stripe-http-client";
import { createStripeWebhookHandler, type BillingSyncQueueMessage } from "./webhook";
import { CloudflareBillingAssignmentStore } from "./cloudflare-assignment-store";
import { CloudflareBillingManagementStore } from "./cloudflare-management-store";
import { createBillingManagementService } from "./management";
import { CloudflareBillingGraceStore } from "./cloudflare-grace-store";
import { createBillingGraceProcessor } from "./grace";
import { isRecord } from "../../unknown-parse";
import { CloudflareBillingHistoryStore } from "./history";
import { CloudflareBillingSupportStore } from "./cloudflare-support-store";
import { CloudflareBillingDeliveryStore } from "./cloudflare-delivery-store";
import { createBillingSupportService } from "./support";
import { createBillingAdverseService } from "./adverse";
import { CloudflareBillingAdverseStore } from "./cloudflare-adverse-store";
import { createLandingPriceCatalog } from "./landing-catalog";
import { resolveBillingOwnerIdentity } from "./cloudflare-owner-identity";

export const BILLING_SYNC_QUEUE_NAME = "haf-bot-billing-sync";

export function createCloudflareBillingRuntime(env: Env) {
  const config = readBillingConfig(env);
  if (!config || !env.HAF_DB || !env.BILLING_SYNC_QUEUE) return null;
  const syncStore = new CloudflareBillingSyncStore(env.HAF_DB);
  const webhookStore = new CloudflareBillingWebhookStore(env.HAF_DB);
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
    store: new CloudflareBillingAdverseStore(env.HAF_DB),
    readEvent: (eventId) => webhookStore.readEvent(eventId),
  });
  const managementService = createBillingManagementService({
    provider: stripe,
    store: new CloudflareBillingManagementStore(env.HAF_DB),
    catalog: config.catalog,
    publicBaseUrl: config.publicBaseUrl,
    syncOwner,
  });
  const assignmentStore = new CloudflareBillingAssignmentStore(env.HAF_DB);
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
      store: new CloudflareBillingGraceStore(env.HAF_DB),
      syncOwner,
    }),
    historyStore: new CloudflareBillingHistoryStore(env.HAF_DB),
    supportService: createBillingSupportService({
      store: new CloudflareBillingSupportStore(env.HAF_DB),
      assignments: assignmentStore,
      delivery: new CloudflareBillingDeliveryStore(env.HAF_DB),
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
    env.STRIPE_FOUNDER_PREMIUM_MONTHLY_PRICE_ID,
    env.STRIPE_FOUNDER_PREMIUM_YEARLY_PRICE_ID,
    env.STRIPE_PREMIUM_PRODUCT_ID,
    env.STRIPE_PREMIUM_YEARLY_PRICE_ID,
    env.STRIPE_PREMIUM_PLUS_MONTHLY_PRICE_ID,
    env.STRIPE_FOUNDER_PREMIUM_PLUS_MONTHLY_PRICE_ID,
    env.STRIPE_FOUNDER_PREMIUM_PLUS_YEARLY_PRICE_ID,
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
      founderPremiumMonthlyPriceId: env.STRIPE_FOUNDER_PREMIUM_MONTHLY_PRICE_ID!,
      founderPremiumYearlyPriceId: env.STRIPE_FOUNDER_PREMIUM_YEARLY_PRICE_ID!,
      legacyFounderPremiumYearlyPriceId: env.STRIPE_LEGACY_FOUNDER_PREMIUM_YEARLY_PRICE_ID,
      founderPremiumPlusMonthlyPriceId: env.STRIPE_FOUNDER_PREMIUM_PLUS_MONTHLY_PRICE_ID!,
      founderPremiumPlusYearlyPriceId: env.STRIPE_FOUNDER_PREMIUM_PLUS_YEARLY_PRICE_ID!,
      legacyFounderPremiumPlusYearlyPriceId: env.STRIPE_LEGACY_FOUNDER_PREMIUM_PLUS_YEARLY_PRICE_ID,
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
  const runtime = createCloudflareBillingRuntime(env);
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
