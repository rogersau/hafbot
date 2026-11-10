import type { QueueProducer, QueueBatch } from "../queue-types";
import type { Env } from "../../env";
import { CommerceBuyerCheckoutService } from "../../commerce/buyer-checkout";
import { CommerceFinancialOperationsService } from "../../commerce/financial-operations";
import { CommerceSafeguardsService } from "../../commerce/safeguards";
import type { CommerceConnectedAccount } from "../../commerce/types";
import { CommerceSupportService } from "../../commerce/support-payments";
import { isCommerceFeatureEnabled } from "../../commerce/production-readiness";
import { isRecord } from "../../unknown-parse";
import { CloudflareCommerceBuyerCheckoutStore } from "./cloudflare-buyer-checkout-store";
import { CloudflareCommerceFinancialOperationsStore } from "./cloudflare-financial-operations-store";
import { CloudflareCommerceSafeguardStore } from "./cloudflare-safeguard-store";
import { CloudflareCommerceSupportStore } from "./cloudflare-support-store";
import { CloudflareCommerceReconciliationStore } from "./cloudflare-reconciliation-store";
import {
  processCommerceReconciliationMessage,
  requestCommerceRefresh,
  scheduleCommerceReconciliation,
  sweepCommerceSyncOutbox,
  type CommerceReconciliationMessage,
  type CommerceSellerSnapshot,
} from "./reconciliation";
import { StripeCommerceBuyerProvider } from "./stripe-buyer-provider";
import { StripeCommerceFinancialOperationsProvider } from "./stripe-financial-operations-provider";
import { StripeCommerceSupportProvider } from "./stripe-support-provider";
import {
  isValidStripeSecretKey,
  isValidStripeWebhookSecret,
  StripeConnectClient,
} from "./stripe-connect-client";
import { StripeCommerceSnapshotProvider } from "./stripe-snapshot-provider";
import { createCommerceStripeWebhookHandler } from "./webhook";
import { processCommerceFinancialProviderActions } from "./financial-provider-actions";
import { createCloudflareCommerceStore } from "../cloudflare-commerce-store";
import type { CommerceSellerReviewNotificationService } from "../../commerce/seller-review-notifications";

export const COMMERCE_SYNC_QUEUE_NAME = "haf-bot-commerce-sync";

export function createCloudflareCommerceRuntime(
  env: Env,
  sellerReviews?: Pick<CommerceSellerReviewNotificationService, "syncSeller" | "retryPending">,
) {
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;

  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const store = new CloudflareCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const provider = new StripeCommerceSnapshotProvider({
    database: env.HAF_DB,
    stripe,
  });
  const commerceStore = createCloudflareCommerceStore(env.HAF_DB);
  const financialOperations = createCommerceFinancialOperationsService(
    env.HAF_DB,
    stripe,
    store,
    queue,
  );

  return {
    webhookHandler: createCommerceStripeWebhookHandler({
      secret: config.webhookSecret,
      store,
      queue,
    }),
    sweepOutbox: () => sweepCommerceSyncOutbox({ store, queue }),
    sweepSellerReviews: () => sellerReviews?.retryPending() ?? Promise.resolve(0),
    scheduleReconciliation: () =>
      scheduleCommerceReconciliation({
        store,
        queue,
        scheduleId: new Date().toISOString().slice(0, 13),
      }),
    sweepFinancialActions: async () => {
      await financialOperations.recoverDueActions();
      await processCommerceFinancialProviderActions({
        database: env.HAF_DB!,
        provider: new StripeCommerceFinancialOperationsProvider(stripe),
        requestReconciliation: async (input) => {
          await requestCommerceRefresh({
            connectedAccountId: input.connectedAccountId,
            source: "admin",
            correlationId: input.correlationId,
            store,
            queue,
          });
        },
      });
    },
    processMessage: (message: CommerceReconciliationMessage, attempts: number) =>
      processCommerceReconciliationMessage({
        message,
        attempts,
        store,
        provider,
        terminalEventHandler: async ({ message, actionId }) => {
          const current = await readLocalCommerceSellerSnapshot(
            env.HAF_DB!,
            message.connectedAccountId,
          );
          await financialOperations.handleUnexpectedDeauthorization({
            guildId: current.connectedAccount.guildId,
            actionId,
          });
          return readLocalCommerceSellerSnapshot(env.HAF_DB!, message.connectedAccountId);
        },
        afterCommit: async (snapshot) => {
          if (!sellerReviews) return;
          try {
            const profile = await commerceStore.readSellerProfile(snapshot.connectedAccount.id);
            if (profile)
              await sellerReviews.syncSeller({ account: snapshot.connectedAccount, profile });
          } catch {
            // The next reconciliation or scheduled retry will recreate the durable request.
          }
        },
      }),
  };
}

export function createCloudflareCommerceBuyerRuntime(
  env: Env,
  premium: { isPremium(guildId: string): Promise<boolean> },
  gameAccess?: import("../../commerce/buyer-checkout").GameAccessCheckoutHooks,
): CommerceBuyerCheckoutService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new CloudflareCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(
    new CloudflareCommerceSafeguardStore(env.HAF_DB),
  );
  return new CommerceBuyerCheckoutService(
    new CloudflareCommerceBuyerCheckoutStore(env.HAF_DB, premium),
    new StripeCommerceBuyerProvider(stripe),
    {
      async request(input) {
        await requestCommerceRefresh({
          connectedAccountId: input.connectedAccountId,
          source: "checkout",
          correlationId: input.correlationId,
          store: reconciliationStore,
          queue,
        });
      },
    },
    safeguards,
    Date.now,
    () => crypto.randomUUID(),
    gameAccess,
  );
}

export function createCloudflareCommerceSupportRuntime(
  env: Env,
  premium: { isPremium(guildId: string): Promise<boolean> },
  currentTermsVersion = "seller-terms-2026-07",
): CommerceSupportService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  if (env.COMMERCE_SUPPORT_PAYMENTS_ENABLED !== "true") return null;
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new CloudflareCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(
    new CloudflareCommerceSafeguardStore(env.HAF_DB),
  );
  return new CommerceSupportService(
    new CloudflareCommerceSupportStore(env.HAF_DB, premium),
    new StripeCommerceSupportProvider(stripe),
    {
      async request(input) {
        await requestCommerceRefresh({
          connectedAccountId: input.connectedAccountId,
          source: "support",
          correlationId: input.correlationId,
          store: reconciliationStore,
          queue,
        });
      },
    },
    currentTermsVersion,
    Date.now,
    () => crypto.randomUUID(),
    safeguards,
  );
}

export function createCloudflareCommerceSafeguardsRuntime(
  env: Env,
): CommerceSafeguardsService | null {
  return env.HAF_DB
    ? new CommerceSafeguardsService(new CloudflareCommerceSafeguardStore(env.HAF_DB))
    : null;
}

export function createCloudflareCommerceFinancialOperationsRuntime(
  env: Env,
): CommerceFinancialOperationsService | null {
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new CloudflareCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  return createCommerceFinancialOperationsService(env.HAF_DB, stripe, reconciliationStore, queue);
}

export async function handleCommerceSyncQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  sellerReviews?: Pick<CommerceSellerReviewNotificationService, "syncSeller" | "retryPending">,
): Promise<void> {
  const runtime = createCloudflareCommerceRuntime(env, sellerReviews);
  if (!runtime) throw new Error("Commerce sync Queue is not fully configured.");

  for (const message of batch.messages) {
    if (!isCommerceReconciliationMessage(message.body)) {
      message.ack();
      continue;
    }
    const result = await runtime.processMessage(message.body, message.attempts);
    if (result === "retry" || result === "leased") message.retry();
    else message.ack();
  }
}

export function readCommerceConfig(env: Env): {
  secretKey: string;
  webhookSecret: string;
  apiVersion: string;
} | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const apiVersion = env.STRIPE_API_VERSION;
  const expectedStripeKeyMode = env.STAGING_MODE === "true" ? "test" : "live";
  if (
    !isValidStripeSecretKey(secretKey, expectedStripeKeyMode) ||
    !isValidStripeWebhookSecret(webhookSecret) ||
    typeof apiVersion !== "string" ||
    apiVersion.length === 0
  ) {
    return null;
  }
  return {
    secretKey,
    webhookSecret,
    apiVersion,
  };
}

function isCommerceReconciliationMessage(value: unknown): value is CommerceReconciliationMessage {
  if (!isRecord(value)) return false;
  const message = value;
  return (
    typeof message.connectedAccountId === "string" &&
    /^acct_[A-Za-z0-9]+$/.test(message.connectedAccountId) &&
    typeof message.eventId === "string" &&
    message.resourceType === "seller" &&
    message.resourceId === message.connectedAccountId &&
    typeof message.generation === "number" &&
    Number.isSafeInteger(message.generation) &&
    message.generation > 0
  );
}

function createCommerceFinancialOperationsService(
  database: D1Database,
  stripe: StripeConnectClient,
  reconciliationStore: CloudflareCommerceReconciliationStore,
  queue: QueueProducer<CommerceReconciliationMessage>,
): CommerceFinancialOperationsService {
  return new CommerceFinancialOperationsService(
    new CloudflareCommerceFinancialOperationsStore(database),
    new StripeCommerceFinancialOperationsProvider(stripe),
    {
      async request(input) {
        await requestCommerceRefresh({
          connectedAccountId: input.connectedAccountId,
          source: "admin",
          correlationId: input.correlationId,
          store: reconciliationStore,
          queue,
        });
      },
    },
  );
}

async function readLocalCommerceSellerSnapshot(
  database: D1Database,
  connectedAccountId: string,
): Promise<CommerceSellerSnapshot> {
  const account = await database
    .prepare(
      `SELECT id, guild_id AS "guildId", stripe_account_id AS "stripeAccountId", status, country,
              default_currency AS "defaultCurrency", charges_enabled AS "chargesEnabled",
              payouts_enabled AS "payoutsEnabled", details_submitted AS "detailsSubmitted",
              provider_created_at_ms AS "providerCreatedAtMs", archived_at_ms AS "archivedAtMs",
              created_at_ms AS "createdAtMs", updated_at_ms AS "updatedAtMs"
       FROM commerce_connected_accounts WHERE id = ? LIMIT 1`,
    )
    .bind(connectedAccountId)
    .first<CommerceAccountRow>();
  if (
    !account ||
    account.id !== connectedAccountId ||
    account.stripeAccountId !== connectedAccountId
  ) {
    throw new Error("commerce_seller_not_connected");
  }

  const connectedAccount: CommerceConnectedAccount = {
    id: account.id,
    guildId: account.guildId,
    stripeAccountId: account.stripeAccountId,
    status: account.status as CommerceConnectedAccount["status"],
    country: account.country,
    defaultCurrency: account.defaultCurrency,
    chargesEnabled: Boolean(account.chargesEnabled),
    payoutsEnabled: Boolean(account.payoutsEnabled),
    detailsSubmitted: Boolean(account.detailsSubmitted),
    providerCreatedAtMs: account.providerCreatedAtMs,
    archivedAtMs: account.archivedAtMs,
    createdAtMs: account.createdAtMs,
    updatedAtMs: account.updatedAtMs,
  };
  return {
    connectedAccount,
    buyers: [],
    customers: [],
    subscriptions: [],
    payments: [],
    refunds: [],
    disputes: [],
    entitlements: [],
    roleAssignments: [],
    observedAtMs: connectedAccount.updatedAtMs,
  };
}

interface CommerceAccountRow {
  id: string;
  guildId: string;
  stripeAccountId: string;
  status: string;
  country: string | null;
  defaultCurrency: CommerceConnectedAccount["defaultCurrency"];
  chargesEnabled: number;
  payoutsEnabled: number;
  detailsSubmitted: number;
  providerCreatedAtMs: number | null;
  archivedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}
