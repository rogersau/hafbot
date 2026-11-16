import type { PostgresDatabaseCapability, PostgresValue } from "./postgres-capability";
import type {
  CommerceBuyer,
  CommerceConnectedAccount,
  CommerceCustomer,
  CommerceDispute,
  CommerceEntitlement,
  CommercePayment,
  CommerceRefund,
  CommerceRoleAssignment,
  CommerceSubscription,
} from "../../commerce";
import type {
  CommerceSupportDispute,
  CommerceSupportPayment,
  CommerceSupportRefund,
} from "../../commerce/support-payments";
import { isRecord } from "../../unknown-parse";
import {
  CommerceProjectionQuarantineError,
  type CommerceReconciliationTrigger,
  type CommerceSellerSnapshot,
  type CommerceSnapshotProvider,
} from "../commerce/reconciliation";
import type { StripeConnectAccount, StripeConnectClient } from "../commerce/stripe-connect-client";

type StripeObject = Record<string, unknown>;

type ConnectedAccountRow = {
  id: string;
  guild_id: string;
  stripe_account_id: string;
  status: string;
  country: string | null;
  default_currency: string | null;
  charges_enabled: number;
  payouts_enabled: number;
  details_submitted: number;
  provider_created_at_ms: number | null;
  archived_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type OfferingRow = {
  id: string;
  connected_account_id: string;
  guild_id: string;
  discord_role_id: string;
  purchase_type: "subscription" | "one_time";
  state: string;
};

type PriceRow = {
  id: string;
  connected_account_id: string;
  offering_id: string;
  stripe_product_id: string;
  stripe_price_id: string;
  currency: "AUD" | "USD";
  price_type: "recurring" | "one_time";
  recurring_interval: "month" | "year" | null;
  status: "active" | "retired";
};

type BuyerRow = {
  id: string;
  discord_user_id: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type CustomerRow = {
  id: string;
  connected_account_id: string;
  buyer_id: string;
  stripe_customer_id: string;
  created_at_ms: number;
  updated_at_ms: number;
};

type ExistingRow = {
  id: string;
  [key: string]: unknown;
};

interface CheckoutRow extends ExistingRow {
  connected_account_id: string;
  guild_id: string;
  offering_id: string;
  price_id: string;
  buyer_id: string;
  stripe_checkout_session_id: string | null;
}

export type StripeCommerceSnapshotProviderOptions = {
  database: PostgresDatabaseCapability;
  stripe: Pick<StripeConnectClient, "readConnectedAccount" | "requestForConnectedAccount">;
  now?: () => number;
  createId?: () => string;
};

/** Reads one seller's complete Stripe projection, with every provider call account scoped. */
export class StripeCommerceSnapshotProvider implements CommerceSnapshotProvider {
  private readonly database: PostgresDatabaseCapability;
  private readonly stripe: StripeCommerceSnapshotProviderOptions["stripe"];
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: StripeCommerceSnapshotProviderOptions) {
    this.database = options.database;
    this.stripe = options.stripe;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  async readSellerSnapshot(input: {
    connectedAccountId: string;
    trigger: CommerceReconciliationTrigger;
  }): Promise<CommerceSellerSnapshot> {
    const accountId = input.connectedAccountId;
    const local = await this.readLocal(accountId);
    if (!local.account || local.account.stripe_account_id !== accountId) {
      throw new CommerceProjectionQuarantineError("unknown_commerce_guild");
    }
    if (local.account.id !== accountId) {
      throw new CommerceProjectionQuarantineError("connected_account_primary_id_mismatch");
    }
    if (local.offerings.some((offering) => offering.connected_account_id !== accountId)) {
      throw new CommerceProjectionQuarantineError("offering_seller_scope_mismatch");
    }
    const providerAccount = await this.stripe.readConnectedAccount(accountId);
    const now = this.now();
    const [
      customerObjects,
      subscriptionObjects,
      invoiceObjects,
      paymentObjects,
      refundObjects,
      disputeObjects,
      applicationFeeObjects,
    ] = await Promise.all([
      this.readStripeList(accountId, "/v1/customers?limit=100"),
      this.readStripeList(
        accountId,
        "/v1/subscriptions?status=all&limit=100&expand[]=data.latest_invoice",
      ),
      this.readStripeList(accountId, "/v1/invoices?limit=100&expand[]=data.payments"),
      this.readStripeList(
        accountId,
        "/v1/payment_intents?limit=100&expand[]=data.latest_charge.balance_transaction",
      ),
      this.readStripeList(accountId, "/v1/refunds?limit=100"),
      this.readStripeList(accountId, "/v1/disputes?limit=100"),
      this.readStripeList(accountId, "/v1/application_fees?limit=100&expand[]=data.refunds"),
    ]);
    const customerByStripe = new Map(customerObjects.map((row) => [stringValue(row.id), row]));
    const buyerById = new Map(local.buyers.map((row) => [row.id, row]));
    const buyerByDiscord = new Map(local.buyers.map((row) => [row.discord_user_id, row]));
    const localCustomerByStripe = new Map(
      local.customers.map((row) => [row.stripe_customer_id, row]),
    );
    const customerRows = new Map<string, CommerceCustomer>();
    const buyerRows = new Map<string, CommerceBuyer>();
    for (const customer of customerObjects) {
      if (hasHafMetadata(customer.metadata)) {
        validateHafMetadata(customer.metadata, {
          accountId,
          guildId: local.account.guild_id,
        });
      }
    }

    const resolveCustomer = (
      stripeCustomerId: string,
      metadataValue: unknown,
      related: boolean,
    ): CommerceCustomer | null => {
      const existing = localCustomerByStripe.get(stripeCustomerId);
      const providerCustomer = customerByStripe.get(stripeCustomerId);
      validateHafMetadata(providerCustomer?.metadata, {
        accountId,
        guildId: local.account.guild_id,
      });
      let buyer = existing ? buyerById.get(existing.buyer_id) : undefined;
      const customerMetadata = recordValue(providerCustomer?.metadata);
      const objectMetadata = recordValue(metadataValue);
      const metadataForBuyer =
        customerMetadata &&
        (stringValue(customerMetadata.haf_buyer_id) ||
          stringValue(customerMetadata.haf_discord_user_id))
          ? customerMetadata
          : objectMetadata;
      if (!buyer && metadataForBuyer) {
        const metadata = metadataForBuyer;
        const buyerId = stringValue(metadata?.haf_buyer_id);
        const discordId = stringValue(metadata?.haf_discord_user_id);
        buyer = buyerById.get(buyerId) ?? buyerByDiscord.get(discordId);
      }
      if (!buyer) {
        if (related || hasHafMetadata(metadataValue)) {
          throw new CommerceProjectionQuarantineError("unknown_commerce_buyer");
        }
        return null;
      }
      if (existing && existing.connected_account_id !== accountId) {
        throw new CommerceProjectionQuarantineError("customer_seller_scope_mismatch");
      }
      const metadata = recordValue(metadataValue);
      const metadataBuyerId = stringValue(metadata?.haf_buyer_id);
      const metadataDiscordId = stringValue(metadata?.haf_discord_user_id);
      if (metadataBuyerId && metadataBuyerId !== buyer.id) {
        throw new CommerceProjectionQuarantineError("commerce_buyer_metadata_mismatch");
      }
      if (metadataDiscordId && metadataDiscordId !== buyer.discord_user_id) {
        throw new CommerceProjectionQuarantineError("commerce_buyer_metadata_mismatch");
      }
      const customerMetadataBuyerId = stringValue(customerMetadata?.haf_buyer_id);
      const customerMetadataDiscordId = stringValue(customerMetadata?.haf_discord_user_id);
      if (customerMetadataBuyerId && customerMetadataBuyerId !== buyer.id) {
        throw new CommerceProjectionQuarantineError("commerce_buyer_metadata_mismatch");
      }
      if (customerMetadataDiscordId && customerMetadataDiscordId !== buyer.discord_user_id) {
        throw new CommerceProjectionQuarantineError("commerce_buyer_metadata_mismatch");
      }
      const customer: CommerceCustomer = {
        id: existing?.id ?? this.createId(),
        connectedAccountId: accountId,
        buyerId: buyer.id,
        stripeCustomerId,
        createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
        updatedAtMs: now,
      };
      customerRows.set(stripeCustomerId, customer);
      buyerRows.set(buyer.id, buyerFromRow(buyer));
      return customer;
    };

    const priceByStripe = new Map(local.prices.map((row) => [row.stripe_price_id, row]));
    const offeringById = new Map(local.offerings.map((row) => [row.id, row]));
    const subscriptions: CommerceSubscription[] = [];
    const entitlements: CommerceEntitlement[] = [];
    const roleAssignments: CommerceRoleAssignment[] = [];
    const existingAssignments = new Map(
      local.roleAssignments.map((row) => [stringValue(row.entitlement_id), row]),
    );
    const existingSubscriptions = new Map(
      local.subscriptions.map((row) => [stringValue(row.stripe_subscription_id), row]),
    );
    const localCheckoutAttempts = new Map(
      local.checkoutAttempts.map((row) => [stringValue(row.id), row]),
    );
    const invoiceById = new Map(invoiceObjects.map((row) => [stringValue(row.id), row]));
    const paymentByIntentObject = new Map(paymentObjects.map((row) => [stringValue(row.id), row]));
    const applicationFees = applicationFeeIndex(applicationFeeObjects);
    const ownedSubscriptions = new Map<string, CommerceSubscription>();

    for (const provider of subscriptionObjects) {
      const stripeSubscriptionId = stringValue(provider.id);
      if (!stripeSubscriptionId) continue;
      validateHafMetadata(provider.metadata, {
        accountId,
        guildId: local.account.guild_id,
      });
      const existing = existingSubscriptions.get(stripeSubscriptionId);
      const price = resolveProviderPrice(provider, priceByStripe, offeringById, local, existing);
      if (!price) {
        if (
          existing ||
          hasHafMetadata(provider.metadata) ||
          hasHafMetadata(customerByStripe.get(objectId(provider.customer))?.metadata)
        ) {
          throw new CommerceProjectionQuarantineError("unknown_commerce_price");
        }
        continue;
      }
      const checkoutAttemptId = stringValue(
        recordValue(provider.metadata)?.haf_checkout_attempt_id,
      );
      if (
        existing?.checkout_attempt_id &&
        checkoutAttemptId &&
        existing.checkout_attempt_id !== checkoutAttemptId
      )
        throw new CommerceProjectionQuarantineError("commerce_checkout_metadata_mismatch");
      if (checkoutAttemptId) {
        const checkoutAttempt = localCheckoutAttempts.get(checkoutAttemptId);
        if (
          !checkoutAttempt ||
          checkoutAttempt.connected_account_id !== accountId ||
          checkoutAttempt.offering_id !== price.offering_id ||
          checkoutAttempt.price_id !== price.id ||
          checkoutAttempt.guild_id !== local.account.guild_id ||
          (stringValue(recordValue(provider.metadata)?.haf_buyer_id) !== "" &&
            stringValue(recordValue(provider.metadata)?.haf_buyer_id) !== checkoutAttempt.buyer_id)
        ) {
          throw new CommerceProjectionQuarantineError("commerce_checkout_metadata_mismatch");
        }
      }
      const stripeCustomerId = objectId(provider.customer);
      const customer = resolveCustomer(
        stripeCustomerId,
        provider.metadata,
        Boolean(
          existing ||
          checkoutAttemptId ||
          hasHafMetadata(provider.metadata) ||
          hasHafMetadata(customerByStripe.get(stripeCustomerId)?.metadata),
        ),
      );
      if (!customer) continue;
      if (
        checkoutAttemptId &&
        localCheckoutAttempts.get(checkoutAttemptId)?.buyer_id !== customer.buyerId
      )
        throw new CommerceProjectionQuarantineError("commerce_checkout_metadata_mismatch");
      const offering = offeringById.get(price.offering_id);
      if (
        !offering ||
        offering.connected_account_id !== accountId ||
        offering.guild_id !== local.account.guild_id
      ) {
        throw new CommerceProjectionQuarantineError("unknown_commerce_guild");
      }
      const status = subscriptionStatus(stringValue(provider.status));
      const latestInvoiceId = objectId(provider.latest_invoice);
      const latestInvoice =
        invoiceById.get(latestInvoiceId) ?? recordValue(provider.latest_invoice);
      const latestPaymentIntentId = invoicePaymentIntentIds(latestInvoice)[0] ?? "";
      const latestPaymentIntent =
        paymentByIntentObject.get(latestPaymentIntentId) ??
        recordValue(latestInvoice?.payment_intent);
      const latestPaymentStatus = latestPaymentIntent
        ? paymentStatus(stringValue(latestPaymentIntent.status))
        : null;
      const latestInvoiceStatus = invoiceStatus(latestInvoice?.status);
      const period = subscriptionPeriod(provider);
      const grace = subscriptionGrace(
        existing,
        status,
        latestInvoiceStatus,
        latestPaymentStatus,
        latestInvoice,
      );
      const subscription: CommerceSubscription = {
        checkoutAttemptId: checkoutAttemptId || stringValue(existing?.checkout_attempt_id) || null,
        id: existing?.id ?? this.createId(),
        connectedAccountId: accountId,
        customerId: customer.id,
        buyerId: customer.buyerId,
        offeringId: offering.id,
        priceId: price.id,
        stripeSubscriptionId,
        status,
        cancelAtPeriodEnd: Boolean(provider.cancel_at_period_end),
        currentPeriodStartMs: period.startMs,
        currentPeriodEndMs: period.endMs,
        canceledAtMs: timestamp(provider.canceled_at),
        endedAtMs: timestamp(provider.ended_at),
        providerUpdatedAtMs: timestamp(provider.created),
        latestInvoiceId: latestInvoiceId || null,
        latestInvoiceStatus,
        latestPaymentIntentId: latestPaymentIntentId || null,
        latestPaymentStatus,
        graceStartedAtMs: grace.startedAtMs,
        graceEndsAtMs: grace.endsAtMs,
        createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
        updatedAtMs: now,
      };
      subscriptions.push(subscription);
      ownedSubscriptions.set(stripeSubscriptionId, subscription);
      const invoice = latestInvoice;
      const invoicePaid =
        invoice?.paid === true || invoice?.status === "paid" || latestPaymentStatus === "succeeded";
      const entitlementStatus =
        status === "active" || status === "trialing"
          ? invoicePaid
            ? "active"
            : "pending"
          : status === "incomplete"
            ? "pending"
            : "revoked";
      const entitlement: CommerceEntitlement = {
        id: existingId(local.entitlements, "source_id", stripeSubscriptionId) ?? this.createId(),
        connectedAccountId: accountId,
        buyerId: customer.buyerId,
        offeringId: offering.id,
        sourceType: "subscription",
        sourceId: stripeSubscriptionId,
        status: entitlementStatus,
        effectiveAtMs: timestamp(provider.start_date) ?? now,
        expiresAtMs:
          status === "canceled" || status === "ended" ? timestamp(provider.ended_at) : null,
        revokedAtMs: entitlementStatus === "revoked" ? (timestamp(provider.ended_at) ?? now) : null,
        createdAtMs:
          existingTimestamp(
            local.entitlements,
            "source_id",
            stripeSubscriptionId,
            "created_at_ms",
          ) ?? now,
        updatedAtMs: now,
      };
      entitlements.push(entitlement);
      roleAssignments.push(
        roleAssignment(
          entitlement,
          offering,
          buyerById.get(customer.buyerId),
          local.account.guild_id,
          now,
          existingAssignments.get(entitlement.id),
        ),
      );
    }

    const payments: CommercePayment[] = [];
    const paymentByIntent = new Map<string, CommercePayment>();
    const supportPayments: CommerceSupportPayment[] = [];
    const supportPaymentByIntent = new Map<string, CommerceSupportPayment>();
    const existingPayments = new Map(
      local.payments.map((row) => [stringValue(row.stripe_payment_intent_id), row]),
    );
    const existingSupportPayments = new Map(
      local.supportPayments.map((row) => [stringValue(row.stripe_payment_intent_id), row]),
    );
    const existingCheckoutAttempts = new Map(
      local.checkoutAttempts.map((row) => [stringValue(row.id), row]),
    );
    const supportAttempts = new Map(
      local.supportCheckoutAttempts.map((row) => [stringValue(row.id), row]),
    );
    const invoicePaymentIntentIdSet = new Set<string>();
    for (const invoice of invoiceObjects) {
      const subscriptionId = invoiceSubscriptionId(invoice);
      const subscription = ownedSubscriptions.get(subscriptionId);
      if (!subscription) {
        if (hasHafMetadata(invoice.metadata)) {
          validateHafMetadata(invoice.metadata, {
            accountId,
            guildId: local.account.guild_id,
          });
        }
        continue;
      }
      validateHafMetadata(invoice.metadata, {
        accountId,
        guildId: local.account.guild_id,
        subscriptionId,
      });
      const invoiceMetadata = recordValue(invoice.metadata);
      const invoiceOfferingId = stringValue(invoiceMetadata?.haf_offering_id);
      if (invoiceOfferingId && invoiceOfferingId !== subscription.offeringId) {
        throw new CommerceProjectionQuarantineError("commerce_offering_metadata_mismatch");
      }
      const intentIds = invoicePaymentIntentIds(invoice);
      if (intentIds.length > 1) {
        throw new CommerceProjectionQuarantineError("multiple_invoice_payments_unsupported");
      }
      const intentId = intentIds[0] ?? "";
      if (!intentId) {
        if (invoice.status === "paid" && numberValue(invoice.amount_paid) > 0) {
          throw new CommerceProjectionQuarantineError("commerce_invoice_payment_missing");
        }
        continue;
      }
      invoicePaymentIntentIdSet.add(intentId);
      const intent = paymentByIntentObject.get(intentId) ?? recordValue(invoice.payment_intent);
      if (!intent) {
        throw new CommerceProjectionQuarantineError("commerce_invoice_payment_intent_missing");
      }
      const payment = membershipPaymentFromInvoice(
        invoice,
        intent,
        subscription,
        applicationFees,
        priceByStripe,
        offeringById,
        existingPayments,
        now,
      );
      payments.push(payment);
      paymentByIntent.set(intentId, payment);
    }

    for (const provider of paymentObjects) {
      const intentId = stringValue(provider.id);
      const metadata = recordValue(provider.metadata);
      validateHafMetadata(metadata, {
        accountId,
        guildId: local.account.guild_id,
      });
      if (stringValue(metadata?.haf_checkout_kind) === "support") {
        const customer = resolveCustomer(objectId(provider.customer), metadata, true);
        if (!customer) continue;
        const attemptId = stringValue(metadata?.haf_checkout_attempt_id);
        const attempt = supportAttempts.get(attemptId);
        if (
          !attempt ||
          stringValue(attempt.connected_account_id) !== accountId ||
          stringValue(attempt.guild_id) !== local.account.guild_id ||
          stringValue(attempt.buyer_id) !== customer.buyerId
        ) {
          throw new CommerceProjectionQuarantineError("unknown_commerce_support_checkout");
        }
        const amount = numberValue(provider.amount);
        const expectedFee = exactSupportFee(amount);
        if (integerMetadata(metadata?.haf_application_fee_minor) !== expectedFee) {
          throw new CommerceProjectionQuarantineError("commerce_support_fee_mismatch");
        }
        const received = Math.min(amount, numberValue(provider.amount_received));
        const latestCharge = recordValue(provider.latest_charge);
        const existing = existingSupportPayments.get(intentId);
        const supportPayment: CommerceSupportPayment = {
          id: existing?.id ?? this.createId(),
          connectedAccountId: accountId,
          guildId: local.account.guild_id,
          customerId: customer.id,
          buyerId: customer.buyerId,
          checkoutAttemptId: attemptId,
          stripePaymentIntentId: intentId,
          stripeChargeId: objectId(provider.latest_charge) || null,
          stripeCheckoutSessionId: stringValue(attempt.stripe_checkout_session_id) || null,
          currency: currency(stringValue(provider.currency)),
          amountMinor: amount,
          amountReceivedMinor: received,
          amountRefundedMinor: Math.min(
            received,
            Math.max(
              numberValue(provider.amount_refunded),
              numberValue(latestCharge?.amount_refunded),
            ),
          ),
          applicationFeeMinor: expectedFee,
          stripeFeeMinor: nullableNumber(recordValue(latestCharge?.balance_transaction)?.fee),
          stripeFeeTaxMinor: feeTaxMinor(latestCharge),
          status: paymentStatus(stringValue(provider.status)),
          providerCreatedAtMs: timestamp(provider.created),
          paidAtMs:
            stringValue(provider.status) === "succeeded" ? timestamp(provider.created) : null,
          createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
          updatedAtMs: now,
        };
        supportPayments.push(supportPayment);
        supportPaymentByIntent.set(intentId, supportPayment);
        continue;
      }
      if (invoicePaymentIntentIdSet.has(intentId)) continue;
      const existing = existingPayments.get(intentId);
      const checkoutAttemptId = stringValue(metadata?.haf_checkout_attempt_id);
      const checkoutAttempt = existingCheckoutAttempts.get(checkoutAttemptId);
      const price = resolvePaymentPrice(
        provider,
        priceByStripe,
        offeringById,
        checkoutAttempt,
        existing,
      );
      if (!price) {
        if (existing || hasHafMetadata(metadata)) {
          throw new CommerceProjectionQuarantineError("unknown_commerce_price");
        }
        continue;
      }
      if (price.price_type === "recurring") continue;
      const customer = resolveCustomer(objectId(provider.customer), metadata, Boolean(existing));
      if (!customer) continue;
      const offering = offeringById.get(price.offering_id);
      if (!offering || offering.guild_id !== local.account.guild_id)
        throw new CommerceProjectionQuarantineError("unknown_commerce_guild");
      const amount = numberValue(provider.amount);
      const received = Math.min(amount, numberValue(provider.amount_received));
      const latestCharge = recordValue(provider.latest_charge);
      const payment: CommercePayment = {
        id: existing?.id ?? this.createId(),
        connectedAccountId: accountId,
        customerId: customer.id,
        buyerId: customer.buyerId,
        offeringId: offering.id,
        priceId: price.id,
        stripePaymentIntentId: intentId,
        stripeChargeId: objectId(provider.latest_charge),
        stripeCheckoutSessionId: stringValue(
          recordValue(provider.metadata)?.haf_checkout_session_id,
        ),
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
        billingPeriodStartMs: null,
        billingPeriodEndMs: null,
        isLatestSubscriptionInvoice: false,
        currency: currency(stringValue(provider.currency)),
        amountMinor: amount,
        amountReceivedMinor: received,
        amountRefundedMinor: Math.min(
          received,
          Math.max(
            numberValue(provider.amount_refunded),
            numberValue(latestCharge?.amount_refunded),
          ),
        ),
        applicationFeeMinor: applicationFeeAmount(
          objectId(provider.latest_charge),
          provider,
          applicationFees,
        ),
        stripeFeeMinor: nullableNumber(recordValue(latestCharge?.balance_transaction)?.fee),
        stripeFeeTaxMinor: feeTaxMinor(latestCharge),
        status: paymentStatus(stringValue(provider.status)),
        providerCreatedAtMs: timestamp(provider.created),
        paidAtMs: stringValue(provider.status) === "succeeded" ? timestamp(provider.created) : null,
        createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
        updatedAtMs: now,
      };
      payments.push(payment);
      paymentByIntent.set(intentId, payment);
      if (payment.status === "succeeded" && offering.purchase_type === "one_time") {
        const entitlement: CommerceEntitlement = {
          id: existingId(local.entitlements, "source_id", intentId) ?? this.createId(),
          connectedAccountId: accountId,
          buyerId: customer.buyerId,
          offeringId: offering.id,
          sourceType: "payment",
          sourceId: intentId,
          status: "active",
          effectiveAtMs: payment.paidAtMs ?? now,
          expiresAtMs: null,
          revokedAtMs: null,
          createdAtMs:
            existingTimestamp(local.entitlements, "source_id", intentId, "created_at_ms") ?? now,
          updatedAtMs: now,
        };
        entitlements.push(entitlement);
        roleAssignments.push(
          roleAssignment(
            entitlement,
            offering,
            buyerById.get(customer.buyerId),
            local.account.guild_id,
            now,
            existingAssignments.get(entitlement.id),
          ),
        );
      }
    }

    const refunds: CommerceRefund[] = [];
    const supportRefunds: CommerceSupportRefund[] = [];
    for (const provider of refundObjects) {
      validateHafMetadata(provider.metadata, {
        accountId,
        guildId: local.account.guild_id,
      });
      const intentId = objectId(provider.payment_intent);
      if (
        supportPaymentByIntent.has(intentId) ||
        local.supportPayments.some((row) => row.stripe_payment_intent_id === intentId)
      ) {
        supportRefunds.push(
          supportRefundFromProvider(
            provider,
            accountId,
            supportPaymentByIntent,
            local.supportPayments,
            local.supportRefunds,
            applicationFees,
            now,
          ),
        );
      } else {
        if (
          paymentByIntent.has(intentId) ||
          local.payments.some((row) => row.stripe_payment_intent_id === intentId)
        ) {
          refunds.push(
            refundFromProvider(
              provider,
              accountId,
              paymentByIntent,
              local.payments,
              local.refunds,
              applicationFees,
              now,
            ),
          );
        } else if (hasHafMetadata(provider.metadata)) {
          throw new CommerceProjectionQuarantineError("unknown_commerce_payment");
        }
      }
    }
    const supportIntentIds = new Set([
      ...supportPaymentByIntent.keys(),
      ...local.supportPayments.map((row) => stringValue(row.stripe_payment_intent_id)),
    ]);
    const supportDisputes = disputeObjects
      .filter((provider) => {
        validateHafMetadata(provider.metadata, {
          accountId,
          guildId: local.account.guild_id,
        });
        return supportIntentIds.has(objectId(provider.payment_intent));
      })
      .map((provider) =>
        supportDisputeFromProvider(
          provider,
          accountId,
          supportPaymentByIntent,
          local.supportPayments,
          local.supportDisputes,
          now,
        ),
      );
    const disputes = disputeObjects
      .filter(
        (provider) =>
          !supportIntentIds.has(objectId(provider.payment_intent)) &&
          (paymentByIntent.has(objectId(provider.payment_intent)) ||
            local.payments.some(
              (row) => row.stripe_payment_intent_id === objectId(provider.payment_intent),
            )),
      )
      .map((provider) =>
        disputeFromProvider(
          provider,
          accountId,
          paymentByIntent,
          local.payments,
          local.disputes,
          now,
        ),
      );
    const expiredCheckoutIds: string[] = [];
    const gameCheckouts = await rows<ExistingRow>(
      this.database,
      `SELECT c.id,c.stripe_checkout_session_id FROM commerce_checkout_attempts c
       JOIN commerce_game_selections gs ON gs.checkout_id=c.id
       WHERE c.connected_account_id=$1 AND c.provider_terminal_at_ms IS NULL AND c.expires_at_ms<=$2
       AND c.stripe_checkout_session_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM commerce_subscriptions s WHERE s.checkout_attempt_id=c.id)
       ORDER BY c.expires_at_ms LIMIT 50`,
      accountId,
      now,
    );
    for (const checkout of gameCheckouts) {
      const sessionId = stringValue(checkout.stripe_checkout_session_id);
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) continue;
      try {
        const session = recordValue(
          await this.stripe.requestForConnectedAccount(
            accountId,
            `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
          ),
        );
        if (
          session?.id === sessionId &&
          session.mode === "subscription" &&
          session.status === "expired" &&
          session.payment_status === "unpaid"
        )
          expiredCheckoutIds.push(stringValue(checkout.id));
      } catch {
        /* Uncertain inventory does not abort independent financial reconciliation. */
      }
    }
    const connectedAccount = accountFromProvider(local.account, providerAccount, now);
    return {
      connectedAccount,
      expiredCheckoutIds,
      buyers: [...buyerRows.values()],
      customers: [...customerRows.values()],
      subscriptions,
      payments,
      refunds,
      disputes,
      entitlements,
      roleAssignments,
      supportPayments,
      supportRefunds,
      supportDisputes,
      observedAtMs: now,
    };
  }

  private async readStripeList(accountId: string, path: string): Promise<StripeObject[]> {
    const values: StripeObject[] = [];
    let cursor: string | null = null;
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const page = await this.stripe.requestForConnectedAccount(
        accountId,
        cursor ? `${path}${separator}starting_after=${encodeURIComponent(cursor)}` : path,
      );
      const record = recordValue(page);
      const objects = listObjects(page);
      values.push(...objects);
      if (record?.has_more !== true || objects.length === 0) return values;
      cursor = stringValue(objects[objects.length - 1]?.id);
      if (!cursor) return values;
    }
  }

  private async readLocal(accountId: string) {
    const [
      accounts,
      offerings,
      prices,
      buyers,
      customers,
      subscriptions,
      payments,
      refunds,
      disputes,
      entitlements,
      roleAssignments,
      checkoutAttempts,
      supportCheckoutAttempts,
      supportPayments,
      supportRefunds,
      supportDisputes,
    ] = await Promise.all([
      rows<ConnectedAccountRow>(
        this.database,
        "SELECT * FROM commerce_connected_accounts WHERE id = $1 OR stripe_account_id = $2 LIMIT 1",
        accountId,
        accountId,
      ),
      rows<OfferingRow>(
        this.database,
        "SELECT id, connected_account_id, guild_id, discord_role_id, purchase_type, state FROM commerce_offerings WHERE connected_account_id = $1",
        accountId,
      ),
      rows<PriceRow>(
        this.database,
        "SELECT id, connected_account_id, offering_id, stripe_product_id, stripe_price_id, currency, price_type, recurring_interval, status FROM commerce_prices WHERE connected_account_id = $1",
        accountId,
      ),
      rows<BuyerRow>(
        this.database,
        "SELECT id, discord_user_id, created_at_ms, updated_at_ms FROM commerce_buyers",
      ),
      rows<CustomerRow>(
        this.database,
        "SELECT id, connected_account_id, buyer_id, stripe_customer_id, created_at_ms, updated_at_ms FROM commerce_customers WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_subscriptions WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_payments WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_refunds WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_disputes WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_entitlements WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_role_assignments WHERE guild_id = (SELECT guild_id FROM commerce_connected_accounts WHERE id = $1)",
        accountId,
      ),
      rows<CheckoutRow>(
        this.database,
        "SELECT * FROM commerce_checkout_attempts WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_support_checkout_attempts WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_support_payments WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_support_refunds WHERE connected_account_id = $1",
        accountId,
      ),
      rows<ExistingRow>(
        this.database,
        "SELECT * FROM commerce_support_disputes WHERE connected_account_id = $1",
        accountId,
      ),
    ]);
    return {
      account: accounts[0],
      offerings,
      prices,
      buyers,
      customers,
      subscriptions,
      payments,
      refunds,
      disputes,
      entitlements,
      roleAssignments,
      checkoutAttempts,
      supportCheckoutAttempts,
      supportPayments,
      supportRefunds,
      supportDisputes,
    };
  }
}

function rows<T extends object>(
  database: PostgresDatabaseCapability,
  query: string,
  ...values: PostgresValue[]
): Promise<T[]> {
  return database.queryResult<T>(query, [...values]).then((result) => result.rows);
}

function listObjects(value: unknown): StripeObject[] {
  const record = recordValue(value);
  return Array.isArray(record?.data)
    ? record.data.filter((item): item is StripeObject => isRecord(item))
    : [];
}

function recordValue(value: unknown): StripeObject | null {
  return isRecord(value) && !Array.isArray(value) ? value : null;
}
function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
function integerMetadata(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}
function objectId(value: unknown): string {
  return typeof value === "string" ? value : stringValue(recordValue(value)?.id);
}
function timestamp(value: unknown): number | null {
  const n = numberValue(value);
  return n === 0 ? null : n < 1_000_000_000_000 ? n * 1000 : n;
}
function currency(value: string): "AUD" | "USD" {
  const upper = value.toUpperCase();
  if (upper !== "AUD" && upper !== "USD")
    throw new CommerceProjectionQuarantineError("unsupported_currency");
  return upper;
}

function resolveProviderPrice(
  provider: StripeObject,
  prices: Map<string, PriceRow>,
  offerings: Map<string, OfferingRow>,
  local: { prices: PriceRow[] },
  existing: ExistingRow | undefined,
): PriceRow | null {
  const existingPrice = local.prices.find((price) => price.id === stringValue(existing?.price_id));
  const metadata = recordValue(provider.metadata);
  const items = recordValue(provider.items);
  const item = Array.isArray(items?.data) ? recordValue(items.data[0]) : null;
  const itemPriceValue = item?.price;
  const itemPrice = recordValue(itemPriceValue);
  const providerPriceId = stringValue(itemPrice?.id) || stringValue(itemPriceValue);
  const metadataPriceId = stringValue(metadata?.haf_price_id) || stringValue(metadata?.price_id);
  if (existingPrice && providerPriceId && providerPriceId !== existingPrice.stripe_price_id) {
    throw new CommerceProjectionQuarantineError("commerce_price_metadata_mismatch");
  }
  const price =
    prices.get(providerPriceId) ??
    prices.get(metadataPriceId) ??
    local.prices.find(
      (candidate) => candidate.id === providerPriceId || candidate.id === metadataPriceId,
    ) ??
    existingPrice;
  if (!price || price.connected_account_id === "" || !offerings.has(price.offering_id)) return null;
  if (
    metadataPriceId &&
    metadataPriceId !== price.id &&
    metadataPriceId !== price.stripe_price_id
  ) {
    throw new CommerceProjectionQuarantineError("commerce_price_metadata_mismatch");
  }
  const productId = stringValue(itemPrice?.product) || stringValue(metadata?.haf_product_id);
  if (productId && productId !== price.stripe_product_id)
    throw new CommerceProjectionQuarantineError("unknown_commerce_product");
  const metadataOfferingId = stringValue(metadata?.haf_offering_id);
  if (metadataOfferingId && metadataOfferingId !== price.offering_id) {
    throw new CommerceProjectionQuarantineError("commerce_offering_metadata_mismatch");
  }
  return price;
}

function resolvePaymentPrice(
  provider: StripeObject,
  prices: Map<string, PriceRow>,
  offerings: Map<string, OfferingRow>,
  checkoutAttempt: CheckoutRow | undefined,
  existing: ExistingRow | undefined,
): PriceRow | null {
  const metadata = recordValue(provider.metadata);
  const attemptPriceId = stringValue(checkoutAttempt?.price_id);
  const existingPriceId = stringValue(existing?.price_id);
  const checkoutAttemptId = stringValue(metadata?.haf_checkout_attempt_id);
  const metadataPriceId = stringValue(metadata?.haf_price_id) || stringValue(metadata?.price_id);
  const providerPrice = recordValue(provider.price);
  const providerPriceId = stringValue(providerPrice?.id) || stringValue(provider.price);
  const price =
    prices.get(metadataPriceId) ??
    prices.get(providerPriceId) ??
    [...prices.values()].find((candidate) => candidate.id === metadataPriceId) ??
    [...prices.values()].find((candidate) => candidate.id === attemptPriceId) ??
    [...prices.values()].find((candidate) => candidate.id === existingPriceId);
  if (!price || !offerings.has(price.offering_id)) return null;
  if (checkoutAttemptId && !checkoutAttempt) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_checkout");
  }
  if (checkoutAttempt) {
    if (
      checkoutAttempt.connected_account_id === "" ||
      checkoutAttempt.guild_id === "" ||
      checkoutAttempt.offering_id !== price.offering_id ||
      (stringValue(metadata?.haf_buyer_id) &&
        stringValue(metadata?.haf_buyer_id) !== checkoutAttempt.buyer_id)
    ) {
      throw new CommerceProjectionQuarantineError("commerce_checkout_metadata_mismatch");
    }
  }
  const metadataOfferingId = stringValue(metadata?.haf_offering_id);
  if (metadataOfferingId && metadataOfferingId !== price.offering_id) {
    throw new CommerceProjectionQuarantineError("commerce_offering_metadata_mismatch");
  }
  const metadataProductId = stringValue(metadata?.haf_product_id);
  if (metadataProductId && metadataProductId !== price.stripe_product_id) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_product");
  }
  return price;
}

function hasHafMetadata(value: unknown): boolean {
  const metadata = recordValue(value);
  return metadata ? Object.keys(metadata).some((key) => key.startsWith("haf_")) : false;
}

function validateHafMetadata(
  value: unknown,
  expected: { accountId: string; guildId: string; subscriptionId?: string },
): void {
  const metadata = recordValue(value);
  if (!metadata) return;
  const checks: Array<[string, string | undefined]> = [
    ["haf_connected_account_id", expected.accountId],
    ["haf_guild_id", expected.guildId],
    ["haf_subscription_id", expected.subscriptionId],
  ];
  for (const [key, expectedValue] of checks) {
    const actual = stringValue(metadata[key]);
    if (actual && expectedValue && actual !== expectedValue) {
      throw new CommerceProjectionQuarantineError("contradictory_haf_metadata");
    }
  }
}

function invoiceStatus(value: unknown): CommerceSubscription["latestInvoiceStatus"] {
  return value === "draft" ||
    value === "open" ||
    value === "paid" ||
    value === "uncollectible" ||
    value === "void"
    ? value
    : null;
}

function subscriptionGrace(
  existing: ExistingRow | undefined,
  subscriptionStatusValue: CommerceSubscription["status"],
  invoiceStatusValue: CommerceSubscription["latestInvoiceStatus"],
  paymentStatusValue: CommerceSubscription["latestPaymentStatus"],
  invoice: StripeObject | null,
): { startedAtMs: number | null; endsAtMs: number | null } {
  const paid =
    invoice?.paid === true || invoiceStatusValue === "paid" || paymentStatusValue === "succeeded";
  if (paid) return { startedAtMs: null, endsAtMs: null };
  const failed =
    subscriptionStatusValue === "past_due" ||
    invoiceStatusValue === "uncollectible" ||
    paymentStatusValue === "failed" ||
    paymentStatusValue === "canceled";
  if (!failed) {
    return {
      startedAtMs: nullableExistingNumber(existing?.grace_started_at_ms),
      endsAtMs: nullableExistingNumber(existing?.grace_ends_at_ms),
    };
  }
  const previousStartedAtMs = nullableExistingNumber(existing?.grace_started_at_ms);
  const startedAtMs =
    previousStartedAtMs ?? timestamp(invoice?.attempted_at) ?? timestamp(invoice?.created);
  return {
    startedAtMs,
    endsAtMs: startedAtMs === null ? null : startedAtMs + GRACE_MS,
  };
}

const GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

function nullableExistingNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

type ApplicationFeeIndex = Map<
  string,
  { amount: number; refunds: StripeObject[]; claimedRefundIds: Set<string> }
>;

function applicationFeeIndex(objects: StripeObject[]): ApplicationFeeIndex {
  const index: ApplicationFeeIndex = new Map();
  for (const object of objects) {
    const chargeId = objectId(object.charge);
    if (!chargeId) continue;
    const refunds = recordValue(object.refunds);
    index.set(chargeId, {
      amount: numberValue(object.amount),
      claimedRefundIds: new Set(),
      refunds: Array.isArray(refunds?.data)
        ? refunds.data.filter((value): value is StripeObject => isRecord(value))
        : [],
    });
  }
  return index;
}

function applicationFeeAmount(
  chargeId: string,
  provider: StripeObject,
  index: ApplicationFeeIndex,
): number | null {
  const value = nullableNumber(provider.application_fee_amount);
  if (value !== null) return value;
  const fee = index.get(chargeId);
  return fee ? fee.amount : null;
}

function applicationFeeRefundAmount(
  provider: StripeObject,
  chargeId: string,
  index: ApplicationFeeIndex,
): number | null {
  const fee = index.get(chargeId);
  if (!fee) return null;
  const explicitRefundId =
    objectId(provider.application_fee_refund) || stringValue(provider.application_fee_refund_id);
  if (explicitRefundId) {
    const refund = fee.refunds.find((candidate) => stringValue(candidate.id) === explicitRefundId);
    if (!refund || fee.claimedRefundIds.has(explicitRefundId)) return null;
    fee.claimedRefundIds.add(explicitRefundId);
    return numberValue(refund.amount);
  }
  if (fee.refunds.length === 1) {
    const refundId = stringValue(fee.refunds[0]?.id);
    if (!refundId || fee.claimedRefundIds.has(refundId)) return null;
    fee.claimedRefundIds.add(refundId);
    return numberValue(fee.refunds[0]?.amount);
  }
  if (fee.refunds.length > 1) {
    const providerCreated = numberValue(provider.created);
    const ranked = fee.refunds
      .filter((refund) => !fee.claimedRefundIds.has(stringValue(refund.id)))
      .map((refund) => ({
        refund,
        distance: Math.abs(numberValue(refund.created) - providerCreated),
      }))
      .sort((left, right) => left.distance - right.distance);
    if (ranked[0] && (!ranked[1] || ranked[0].distance < ranked[1].distance)) {
      fee.claimedRefundIds.add(stringValue(ranked[0].refund.id));
      return numberValue(ranked[0].refund.amount);
    }
  }
  return null;
}

function feeTaxMinor(charge: StripeObject | null): number | null {
  const balanceTransaction = recordValue(charge?.balance_transaction);
  const details = balanceTransaction?.fee_details;
  if (!Array.isArray(details)) return null;
  const tax = details.reduce((total, detail) => {
    const row = recordValue(detail);
    return total + (stringValue(row?.type) === "tax" ? numberValue(row?.amount) : 0);
  }, 0);
  return tax > 0 ? tax : null;
}

function membershipPaymentFromInvoice(
  invoice: StripeObject,
  intent: StripeObject,
  subscription: CommerceSubscription,
  applicationFees: ApplicationFeeIndex,
  prices: Map<string, PriceRow>,
  offerings: Map<string, OfferingRow>,
  existingPayments: Map<string, ExistingRow>,
  now: number,
): CommercePayment {
  const intentId = invoicePaymentIntentIds(invoice)[0] || stringValue(intent.id);
  const invoiceId = stringValue(invoice.id);
  const charge = recordValue(intent.latest_charge);
  const existing = [...existingPayments.values()].find(
    (row) =>
      stringValue(row.stripe_invoice_id) === invoiceId ||
      stringValue(row.stripe_payment_intent_id) === intentId,
  );
  const amount =
    numberValue(invoice.amount_paid) ||
    numberValue(invoice.amount_due) ||
    numberValue(intent.amount);
  const received = Math.min(
    amount,
    numberValue(intent.amount_received) || numberValue(invoice.amount_paid),
  );
  const status =
    invoice.paid === true || invoice.status === "paid"
      ? "succeeded"
      : stringValue(intent.status)
        ? paymentStatus(stringValue(intent.status))
        : "failed";
  const period = invoicePeriod(invoice);
  const invoiceStripePriceId = invoicePriceId(invoice);
  const invoicePrice = invoiceStripePriceId ? prices.get(invoiceStripePriceId) : null;
  if (invoiceStripePriceId && !invoicePrice) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_price");
  }
  if (invoicePrice && invoicePrice.offering_id !== subscription.offeringId) {
    throw new CommerceProjectionQuarantineError("commerce_offering_metadata_mismatch");
  }
  if (invoicePrice && !offerings.has(invoicePrice.offering_id)) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_guild");
  }
  return {
    id: existing?.id ?? `payment:${intentId}:${invoiceId}`,
    connectedAccountId: subscription.connectedAccountId,
    customerId: subscription.customerId,
    buyerId: subscription.buyerId,
    offeringId: subscription.offeringId,
    priceId: invoicePrice?.id ?? subscription.priceId,
    stripePaymentIntentId: intentId,
    stripeChargeId: objectId(intent.latest_charge) || null,
    stripeCheckoutSessionId: null,
    stripeInvoiceId: invoiceId || null,
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    billingPeriodStartMs: period.startMs,
    billingPeriodEndMs: period.endMs,
    isLatestSubscriptionInvoice: invoiceId !== "" && invoiceId === subscription.latestInvoiceId,
    currency: currency(stringValue(invoice.currency) || stringValue(intent.currency)),
    amountMinor: amount,
    amountReceivedMinor: received,
    amountRefundedMinor: Math.min(
      received,
      Math.max(numberValue(intent.amount_refunded), numberValue(charge?.amount_refunded)),
    ),
    applicationFeeMinor: applicationFeeAmount(
      objectId(intent.latest_charge),
      intent,
      applicationFees,
    ),
    stripeFeeMinor: nullableNumber(recordValue(charge?.balance_transaction)?.fee),
    stripeFeeTaxMinor: feeTaxMinor(charge),
    status,
    providerCreatedAtMs: timestamp(invoice.created) ?? timestamp(intent.created),
    paidAtMs:
      invoice.status === "paid"
        ? (timestamp(recordValue(invoice.status_transitions)?.paid_at) ??
          timestamp(invoice.created))
        : status === "succeeded"
          ? timestamp(intent.created)
          : null,
    createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
    updatedAtMs: now,
  };
}

function invoicePeriod(invoice: StripeObject): { startMs: number | null; endMs: number | null } {
  const lines = recordValue(invoice.lines);
  const firstLine = Array.isArray(lines?.data) ? recordValue(lines.data[0]) : null;
  const period = recordValue(firstLine?.period) ?? recordValue(invoice.period);
  return {
    startMs: timestamp(period?.start),
    endMs: timestamp(period?.end),
  };
}

function subscriptionPeriod(subscription: StripeObject): {
  startMs: number | null;
  endMs: number | null;
} {
  const items = recordValue(subscription.items);
  const firstItem = Array.isArray(items?.data) ? recordValue(items.data[0]) : null;
  return {
    startMs:
      timestamp(firstItem?.current_period_start) ?? timestamp(subscription.current_period_start),
    endMs: timestamp(firstItem?.current_period_end) ?? timestamp(subscription.current_period_end),
  };
}

function invoicePaymentIntentIds(invoice: StripeObject | null): string[] {
  if (!invoice) return [];
  const ids = new Set<string>();
  const directPaymentIntentId = objectId(invoice.payment_intent);
  if (directPaymentIntentId) ids.add(directPaymentIntentId);
  const payments = recordValue(invoice.payments);
  if (!Array.isArray(payments?.data)) return [...ids];
  for (const value of payments.data) {
    const payment = recordValue(recordValue(value)?.payment);
    if (stringValue(payment?.type) !== "payment_intent") continue;
    const id = objectId(payment?.payment_intent);
    if (id) ids.add(id);
  }
  return [...ids];
}

function invoiceSubscriptionId(invoice: StripeObject): string {
  const direct = objectId(invoice.subscription);
  if (direct) return direct;
  const parent = recordValue(invoice.parent);
  const subscriptionDetails = recordValue(parent?.subscription_details);
  const parentSubscription = objectId(subscriptionDetails?.subscription);
  if (parentSubscription) return parentSubscription;
  const lines = recordValue(invoice.lines);
  const firstLine = Array.isArray(lines?.data) ? recordValue(lines.data[0]) : null;
  return objectId(firstLine?.subscription);
}

function invoicePriceId(invoice: StripeObject): string {
  const lines = recordValue(invoice.lines);
  const firstLine = Array.isArray(lines?.data) ? recordValue(lines.data[0]) : null;
  const price = firstLine?.price;
  const pricing = recordValue(firstLine?.pricing);
  const priceDetails = recordValue(pricing?.price_details);
  return objectId(price) || objectId(priceDetails?.price);
}

function subscriptionStatus(value: string): CommerceSubscription["status"] {
  return value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "paused" ||
    value === "unpaid" ||
    value === "canceled"
    ? value
    : value === "incomplete"
      ? "incomplete"
      : "ended";
}
function paymentStatus(value: string): CommercePayment["status"] {
  return value === "succeeded"
    ? "succeeded"
    : value === "processing"
      ? "processing"
      : value === "requires_action"
        ? "requires_action"
        : value === "canceled"
          ? "canceled"
          : "failed";
}
function buyerFromRow(row: BuyerRow): CommerceBuyer {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
function existingId(rowsList: ExistingRow[], key: string, value: string): string | null {
  return rowsList.find((row) => row[key] === value)?.id ?? null;
}
function existingTimestamp(
  rowsList: ExistingRow[],
  key: string,
  value: string,
  timestampKey: string,
): number | null {
  const row = rowsList.find((candidate) => candidate[key] === value);
  return row ? numberValue(row[timestampKey]) : null;
}

function roleAssignment(
  entitlement: CommerceEntitlement,
  offering: OfferingRow,
  buyer: BuyerRow | undefined,
  guildId: string,
  now: number,
  existing: ExistingRow | undefined,
): CommerceRoleAssignment {
  if (!buyer) throw new CommerceProjectionQuarantineError("unknown_commerce_buyer");
  const active = entitlement.status === "active";
  const eligible = active;
  const existingStatus = stringValue(existing?.status);
  const status = existing
    ? eligible
      ? existingStatus === "removed" || existingStatus === "removing"
        ? "pending"
        : (existingStatus as CommerceRoleAssignment["status"]) || "pending"
      : existingStatus === "removed"
        ? "removed"
        : "removing"
    : eligible
      ? "pending"
      : "removed";
  return {
    id: existing?.id ? stringValue(existing.id) : `role:${entitlement.id}`,
    entitlementId: entitlement.id,
    guildId,
    discordUserId: buyer.discord_user_id,
    discordRoleId: offering.discord_role_id,
    status,
    attemptCount: existing ? numberValue(existing.attempt_count) : 0,
    lastErrorCode: existing ? stringValue(existing.last_error_code) || null : null,
    nextAttemptAtMs: existing ? nullableNumber(existing.next_attempt_at_ms) : null,
    assignedAtMs: existing ? nullableNumber(existing.assigned_at_ms) : null,
    removedAtMs: eligible ? null : existing ? (nullableNumber(existing.removed_at_ms) ?? now) : now,
    createdAtMs: existing ? numberValue(existing.created_at_ms) : now,
    updatedAtMs: now,
  };
}

function accountFromProvider(
  local: ConnectedAccountRow,
  provider: StripeConnectAccount,
  now: number,
): CommerceConnectedAccount {
  const status: CommerceConnectedAccount["status"] = provider.disabledReason
    ? "restricted"
    : provider.chargesEnabled && provider.payoutsEnabled
      ? "active"
      : "pending";
  return {
    // Reconciliation messages and the projection share the provider account ID.
    id: provider.id,
    guildId: local.guild_id,
    stripeAccountId: provider.id,
    status,
    country: provider.country as CommerceConnectedAccount["country"],
    defaultCurrency: provider.defaultCurrency === null ? null : currency(provider.defaultCurrency),
    chargesEnabled: provider.chargesEnabled,
    payoutsEnabled: provider.payoutsEnabled,
    detailsSubmitted: provider.detailsSubmitted,
    providerCreatedAtMs: provider.providerCreatedAtMs,
    archivedAtMs: local.archived_at_ms,
    createdAtMs: local.created_at_ms,
    updatedAtMs: now,
  };
}

function refundFromProvider(
  provider: StripeObject,
  accountId: string,
  payments: Map<string, CommercePayment>,
  existingPayments: ExistingRow[],
  existing: ExistingRow[],
  applicationFees: ApplicationFeeIndex,
  now: number,
): CommerceRefund {
  const paymentId = objectId(provider.payment_intent);
  const payment = payments.get(paymentId);
  const localPayment = existingPayments.find((row) => row.stripe_payment_intent_id === paymentId);
  if (!payment && !localPayment)
    throw new CommerceProjectionQuarantineError("unknown_commerce_payment");
  const id = stringValue(provider.id);
  const chargeId = payment?.stripeChargeId ?? stringValue(localPayment?.stripe_charge_id);
  return {
    id: existingId(existing, "stripe_refund_id", id) ?? `refund:${id}`,
    connectedAccountId: accountId,
    paymentId: payment?.id ?? localPayment?.id ?? "",
    stripeRefundId: id,
    currency: currency(stringValue(provider.currency)),
    amountMinor: numberValue(provider.amount),
    applicationFeeRefundedMinor: applicationFeeRefundAmount(provider, chargeId, applicationFees),
    status: refundStatus(stringValue(provider.status)),
    reason: stringValue(provider.reason) || null,
    providerCreatedAtMs: timestamp(provider.created),
    createdAtMs: now,
    updatedAtMs: now,
  };
}
function refundStatus(value: string): CommerceRefund["status"] {
  return value === "succeeded" || value === "failed" || value === "canceled" ? value : "pending";
}

function supportRefundFromProvider(
  provider: StripeObject,
  accountId: string,
  payments: Map<string, CommerceSupportPayment>,
  existingPayments: ExistingRow[],
  existingRefunds: ExistingRow[],
  applicationFees: ApplicationFeeIndex,
  now: number,
): CommerceSupportRefund {
  const paymentIntentId = objectId(provider.payment_intent);
  const payment = payments.get(paymentIntentId);
  const localPayment = existingPayments.find(
    (row) => row.stripe_payment_intent_id === paymentIntentId,
  );
  if (!payment && !localPayment) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_support_payment");
  }
  const paymentId = payment?.id ?? stringValue(localPayment?.id);
  const paymentAmount = payment?.amountMinor ?? numberValue(localPayment?.amount_minor);
  const applicationFee =
    payment?.applicationFeeMinor ?? numberValue(localPayment?.application_fee_minor);
  const chargeId = payment?.stripeChargeId ?? stringValue(localPayment?.stripe_charge_id);
  const refundAmount = numberValue(provider.amount);
  const id = stringValue(provider.id);
  return {
    id: existingId(existingRefunds, "stripe_refund_id", id) ?? `support-refund:${id}`,
    connectedAccountId: accountId,
    supportPaymentId: paymentId,
    stripeRefundId: id,
    currency: currency(stringValue(provider.currency)),
    amountMinor: refundAmount,
    applicationFeeRefundedMinor:
      applicationFeeRefundAmount(provider, chargeId, applicationFees) ??
      (paymentAmount > 0 ? Math.floor((applicationFee * refundAmount) / paymentAmount) : null),
    status: refundStatus(stringValue(provider.status)),
    reason: stringValue(provider.reason) || null,
    providerCreatedAtMs: timestamp(provider.created),
    createdAtMs: existingTimestamp(existingRefunds, "stripe_refund_id", id, "created_at_ms") ?? now,
    updatedAtMs: now,
  };
}

function exactSupportFee(amountMinor: number): number {
  if (amountMinor < 200 || amountMinor > 50_000 || amountMinor % 20 !== 0) {
    throw new CommerceProjectionQuarantineError("commerce_support_amount_invalid");
  }
  return amountMinor / 20;
}

function disputeFromProvider(
  provider: StripeObject,
  accountId: string,
  payments: Map<string, CommercePayment>,
  existingPayments: ExistingRow[],
  existing: ExistingRow[],
  now: number,
): CommerceDispute {
  const paymentId = objectId(provider.payment_intent);
  const payment = payments.get(paymentId);
  const localPayment = existingPayments.find((row) => row.stripe_payment_intent_id === paymentId);
  if (!payment && !localPayment)
    throw new CommerceProjectionQuarantineError("unknown_commerce_payment");
  const id = stringValue(provider.id);
  return {
    id: existingId(existing, "stripe_dispute_id", id) ?? `dispute:${id}`,
    connectedAccountId: accountId,
    paymentId: payment?.id ?? localPayment?.id ?? "",
    stripeDisputeId: id,
    currency: currency(stringValue(provider.currency)),
    amountMinor: numberValue(provider.amount),
    status: disputeStatus(stringValue(provider.status)),
    reason: stringValue(provider.reason) || null,
    providerCreatedAtMs: timestamp(provider.created),
    closedAtMs: timestamp(provider.closed),
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function supportDisputeFromProvider(
  provider: StripeObject,
  accountId: string,
  payments: Map<string, CommerceSupportPayment>,
  existingPayments: ExistingRow[],
  existing: ExistingRow[],
  now: number,
): CommerceSupportDispute {
  const paymentIntentId = objectId(provider.payment_intent);
  const payment = payments.get(paymentIntentId);
  const localPayment = existingPayments.find(
    (row) => row.stripe_payment_intent_id === paymentIntentId,
  );
  if (!payment && !localPayment) {
    throw new CommerceProjectionQuarantineError("unknown_commerce_support_payment");
  }
  const id = stringValue(provider.id);
  return {
    id: existingId(existing, "stripe_dispute_id", id) ?? `support-dispute:${id}`,
    connectedAccountId: accountId,
    supportPaymentId: payment?.id ?? stringValue(localPayment?.id),
    stripeDisputeId: id,
    currency: currency(stringValue(provider.currency)),
    amountMinor: numberValue(provider.amount),
    status: disputeStatus(stringValue(provider.status)),
    reason: stringValue(provider.reason) || null,
    providerCreatedAtMs: timestamp(provider.created),
    closedAtMs: timestamp(provider.closed),
    createdAtMs: existingTimestamp(existing, "stripe_dispute_id", id, "created_at_ms") ?? now,
    updatedAtMs: now,
  };
}

function disputeStatus(value: string): CommerceDispute["status"] {
  return value === "warning_needs_response" ||
    value === "warning_under_review" ||
    value === "warning_closed" ||
    value === "needs_response" ||
    value === "under_review" ||
    value === "won" ||
    value === "lost"
    ? value
    : "under_review";
}
