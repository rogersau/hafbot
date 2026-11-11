import type { PostgresDatabaseCapability } from "../postgres/postgres-capability";
import type { QueueJobMetadata } from "../queue-types";
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
import { deliverQueueJob, type QueueDeliveryOutcome } from "../queue-delivery";

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

export type BillingSyncProcessingResult = "processed" | "already_processed" | "retry" | "terminal";

export interface BillingSyncDeliveryPort {
  processMessage(
    message: BillingSyncQueueMessage,
    attempts: number,
  ): Promise<BillingSyncProcessingResult>;
}

export async function deliverBillingSync(
  payload: unknown,
  metadata: QueueJobMetadata,
  processing: BillingSyncDeliveryPort,
): Promise<QueueDeliveryOutcome> {
  return deliverQueueJob(payload, {
    metadata,
    parse(body) {
      return isBillingSyncMessage(body)
        ? { ok: true, value: body }
        : { ok: false, reasonCode: "invalid_billing_sync_message" };
    },
    async handle(message) {
      const result = await processing.processMessage(message, metadata.attempts);
      if (result === "retry") {
        return { status: "retry", reasonCode: "billing_sync_retry" };
      }
      if (result === "terminal") {
        return { status: "terminal", reasonCode: "billing_sync_terminal" };
      }
      return { status: "complete" };
    },
  });
}

function isBillingSyncMessage(value: unknown): value is BillingSyncQueueMessage {
  return (
    isRecord(value) && typeof value.eventId === "string" && typeof value.customerId === "string"
  );
}
