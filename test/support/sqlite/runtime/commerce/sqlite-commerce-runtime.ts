import type { QueueProducer } from "../../../../../src/runtime/queue-types";
import type { Env } from "../../../test-env";
import { CommerceBuyerCheckoutService } from "../../../../../src/commerce/buyer-checkout";
import { CommerceFinancialOperationsService } from "../../../../../src/commerce/financial-operations";
import { CommerceSafeguardsService } from "../../../../../src/commerce/safeguards";
import type { CommerceConnectedAccount } from "../../../../../src/commerce/types";
import { CommerceSupportService } from "../../../../../src/commerce/support-payments";
import { isCommerceFeatureEnabled } from "../../../../../src/commerce/production-readiness";
import { SqliteCommerceBuyerCheckoutStore } from "./sqlite-buyer-checkout-store";
import { SqliteCommerceFinancialOperationsStore } from "./sqlite-financial-operations-store";
import { SqliteCommerceSafeguardStore } from "./sqlite-safeguard-store";
import { SqliteCommerceSupportStore } from "./sqlite-support-store";
import { SqliteCommerceReconciliationStore } from "./sqlite-reconciliation-store";
import {
  processCommerceReconciliationMessage,
  requestCommerceRefresh,
  scheduleCommerceReconciliation,
  sweepCommerceSyncOutbox,
  type CommerceReconciliationMessage,
  type CommerceSellerSnapshot,
} from "../../../../../src/runtime/commerce/reconciliation";
import { StripeCommerceBuyerProvider } from "../../../../../src/runtime/commerce/stripe-buyer-provider";
import { StripeCommerceFinancialOperationsProvider } from "../../../../../src/runtime/commerce/stripe-financial-operations-provider";
import { StripeCommerceSupportProvider } from "../../../../../src/runtime/commerce/stripe-support-provider";
import {
  isValidStripeSecretKey,
  isValidStripeWebhookSecret,
  StripeConnectClient,
} from "../../../../../src/runtime/commerce/stripe-connect-client";
import { StripeCommerceSnapshotProvider } from "./stripe-snapshot-provider";
import { createCommerceStripeWebhookHandler } from "../../../../../src/runtime/commerce/webhook";
import { processCommerceFinancialProviderActions } from "./financial-provider-actions";
import { createSqliteCommerceStore } from "../sqlite-commerce-store";
import type { CommerceSellerReviewNotificationService } from "../../../../../src/commerce/seller-review-notifications";

export const COMMERCE_SYNC_QUEUE_NAME = "haf-bot-commerce-sync";

export function createSqliteCommerceRuntime(
  env: Env,
  sellerReviews?: Pick<CommerceSellerReviewNotificationService, "syncSeller" | "retryPending">,
) {
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;

  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const store = new SqliteCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const provider = new StripeCommerceSnapshotProvider({
    database: env.HAF_DB,
    stripe,
  });
  const commerceStore = createSqliteCommerceStore(env.HAF_DB);
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

export function createSqliteCommerceBuyerRuntime(
  env: Env,
  premium: { isPremium(guildId: string): Promise<boolean> },
  gameAccess?: import("../../../../../src/commerce/buyer-checkout").GameAccessCheckoutHooks,
): CommerceBuyerCheckoutService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new SqliteCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(new SqliteCommerceSafeguardStore(env.HAF_DB));
  return new CommerceBuyerCheckoutService(
    new SqliteCommerceBuyerCheckoutStore(env.HAF_DB, premium),
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

export function createSqliteCommerceSupportRuntime(
  env: Env,
  premium: { isPremium(guildId: string): Promise<boolean> },
  currentTermsVersion = "seller-terms-2026-07",
): CommerceSupportService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  if (env.COMMERCE_SUPPORT_PAYMENTS_ENABLED !== "true") return null;
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new SqliteCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(new SqliteCommerceSafeguardStore(env.HAF_DB));
  return new CommerceSupportService(
    new SqliteCommerceSupportStore(env.HAF_DB, premium),
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

export function createSqliteCommerceSafeguardsRuntime(env: Env): CommerceSafeguardsService | null {
  return env.HAF_DB
    ? new CommerceSafeguardsService(new SqliteCommerceSafeguardStore(env.HAF_DB))
    : null;
}

export function createSqliteCommerceFinancialOperationsRuntime(
  env: Env,
): CommerceFinancialOperationsService | null {
  const config = readCommerceConfig(env);
  if (!config || !env.HAF_DB || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new SqliteCommerceReconciliationStore(env.HAF_DB);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  return createCommerceFinancialOperationsService(env.HAF_DB, stripe, reconciliationStore, queue);
}

export { deliverCommerceSync } from "../../../../../src/runtime/commerce/postgres-runtime";

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

function createCommerceFinancialOperationsService(
  database: D1Database,
  stripe: StripeConnectClient,
  reconciliationStore: SqliteCommerceReconciliationStore,
  queue: QueueProducer<CommerceReconciliationMessage>,
): CommerceFinancialOperationsService {
  return new CommerceFinancialOperationsService(
    new SqliteCommerceFinancialOperationsStore(database),
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
