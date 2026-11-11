import type { PostgresDatabaseCapability } from "../postgres/postgres-capability";
import type { QueueProducer, QueueBatch } from "../queue-types";
import type { Env } from "../../env";
import { CommerceBuyerCheckoutService } from "../../commerce/buyer-checkout";
import { CommerceFinancialOperationsService } from "../../commerce/financial-operations";
import { CommerceSafeguardsService } from "../../commerce/safeguards";
import type { CommerceConnectedAccount } from "../../commerce/types";
import { CommerceSupportService } from "../../commerce/support-payments";
import { isCommerceFeatureEnabled } from "../../commerce/production-readiness";
import { isRecord } from "../../unknown-parse";
import { PostgresCommerceBuyerCheckoutStore } from "../postgres/postgres-commerce-buyer-checkout-store";
import { PostgresCommerceFinancialOperationsStore } from "../postgres/postgres-commerce-financial-operations-store";
import { PostgresCommerceSafeguardStore } from "../postgres/postgres-commerce-safeguard-store";
import { PostgresCommerceSupportStore } from "../postgres/postgres-commerce-support-store";
import { PostgresCommerceReconciliationStore } from "../postgres/postgres-commerce-reconciliation-store";
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
import { StripeCommerceSnapshotProvider } from "../postgres/postgres-commerce-snapshot-provider";
import { createCommerceStripeWebhookHandler } from "./webhook";
import { processCommerceFinancialProviderActions } from "../postgres/postgres-commerce-financial-provider-actions";
import { createPostgresCommerceStore } from "../postgres/postgres-commerce-store";
import type { CommerceSellerReviewNotificationService } from "../../commerce/seller-review-notifications";

export const COMMERCE_SYNC_QUEUE_NAME = "haf-bot-commerce-sync";

export function createPostgresCommerceRuntime(
  env: Env,
  database: PostgresDatabaseCapability,
  sellerReviews?: Pick<CommerceSellerReviewNotificationService, "syncSeller" | "retryPending">,
) {
  const config = readCommerceConfig(env);
  if (!config || !env.COMMERCE_SYNC_QUEUE) return null;

  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const store = new PostgresCommerceReconciliationStore(database);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const provider = new StripeCommerceSnapshotProvider({
    database: database,
    stripe,
  });
  const commerceStore = createPostgresCommerceStore(database);
  const financialOperations = createCommerceFinancialOperationsService(
    database,
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
        database: database,
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
            database,
            message.connectedAccountId,
          );
          await financialOperations.handleUnexpectedDeauthorization({
            guildId: current.connectedAccount.guildId,
            actionId,
          });
          return readLocalCommerceSellerSnapshot(database, message.connectedAccountId);
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

export function createPostgresCommerceBuyerRuntime(
  env: Env,
  database: PostgresDatabaseCapability,
  premium: { isPremium(guildId: string): Promise<boolean> },
  gameAccess?: import("../../commerce/buyer-checkout").GameAccessCheckoutHooks,
): CommerceBuyerCheckoutService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  const config = readCommerceConfig(env);
  if (!config || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new PostgresCommerceReconciliationStore(database);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(new PostgresCommerceSafeguardStore(database));
  return new CommerceBuyerCheckoutService(
    new PostgresCommerceBuyerCheckoutStore(database, premium),
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

export function createPostgresCommerceSupportRuntime(
  env: Env,
  database: PostgresDatabaseCapability,
  premium: { isPremium(guildId: string): Promise<boolean> },
  currentTermsVersion = "seller-terms-2026-07",
): CommerceSupportService | null {
  if (!isCommerceFeatureEnabled(env)) return null;
  if (env.COMMERCE_SUPPORT_PAYMENTS_ENABLED !== "true") return null;
  const config = readCommerceConfig(env);
  if (!config || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new PostgresCommerceReconciliationStore(database);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  const safeguards = new CommerceSafeguardsService(new PostgresCommerceSafeguardStore(database));
  return new CommerceSupportService(
    new PostgresCommerceSupportStore(database, premium),
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

export function createPostgresCommerceSafeguardsRuntime(
  database: PostgresDatabaseCapability,
): CommerceSafeguardsService | null {
  return new CommerceSafeguardsService(new PostgresCommerceSafeguardStore(database));
}

export function createPostgresCommerceFinancialOperationsRuntime(
  env: Env,
  database: PostgresDatabaseCapability,
): CommerceFinancialOperationsService | null {
  const config = readCommerceConfig(env);
  if (!config || !env.COMMERCE_SYNC_QUEUE) return null;
  const queue = env.COMMERCE_SYNC_QUEUE as QueueProducer<CommerceReconciliationMessage>;
  const reconciliationStore = new PostgresCommerceReconciliationStore(database);
  const stripe = new StripeConnectClient(config.secretKey, config.apiVersion);
  return createCommerceFinancialOperationsService(database, stripe, reconciliationStore, queue);
}

export async function handleCommerceSyncQueueBatch(
  batch: QueueBatch<unknown>,
  env: Env,
  database: PostgresDatabaseCapability,
  sellerReviews?: Pick<CommerceSellerReviewNotificationService, "syncSeller" | "retryPending">,
): Promise<void> {
  const runtime = createPostgresCommerceRuntime(env, database, sellerReviews);
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
  database: PostgresDatabaseCapability,
  stripe: StripeConnectClient,
  reconciliationStore: PostgresCommerceReconciliationStore,
  queue: QueueProducer<CommerceReconciliationMessage>,
): CommerceFinancialOperationsService {
  return new CommerceFinancialOperationsService(
    new PostgresCommerceFinancialOperationsStore(database),
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
  database: PostgresDatabaseCapability,
  connectedAccountId: string,
): Promise<CommerceSellerSnapshot> {
  const account = await database
    .query<CommerceAccountRow>(
      'SELECT id, guild_id AS "guildId", stripe_account_id AS "stripeAccountId", status, country,\n              default_currency AS "defaultCurrency", charges_enabled AS "chargesEnabled",\n              payouts_enabled AS "payoutsEnabled", details_submitted AS "detailsSubmitted",\n              provider_created_at_ms AS "providerCreatedAtMs", archived_at_ms AS "archivedAtMs",\n              created_at_ms AS "createdAtMs", updated_at_ms AS "updatedAtMs"\n       FROM commerce_connected_accounts WHERE id = $1 LIMIT 1',
      [connectedAccountId],
    )
    .then((rows) => rows[0] ?? null);
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

type CommerceAccountRow = {
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
};
