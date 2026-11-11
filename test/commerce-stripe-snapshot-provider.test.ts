/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { StripeCommerceSnapshotProvider } from "./support/sqlite/runtime/commerce/stripe-snapshot-provider";
import { CommerceProjectionQuarantineError } from "../src/runtime/commerce/reconciliation";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;

test("builds a coherent seller snapshot using account-scoped Stripe reads", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  const calls: string[] = [];
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    now: () => NOW,
    stripe: {
      async readConnectedAccount(id) {
        assert.equal(id, "acct_1");
        return account();
      },
      async requestForConnectedAccount(id, path) {
        calls.push(`${id}:${path}`);
        return response(path);
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: { eventType: "invoice.paid", objectId: "pi_1", source: "webhook" },
  });
  assert.equal(snapshot.connectedAccount.guildId, "guild_1");
  assert.equal(snapshot.connectedAccount.defaultCurrency, "AUD");
  assert.equal(snapshot.customers[0]?.buyerId, "buyer_1");
  assert.equal(snapshot.subscriptions[0]?.status, "active");
  assert.equal(snapshot.subscriptions[0]?.latestPaymentStatus, "succeeded");
  assert.equal(snapshot.subscriptions[0]?.currentPeriodEndMs, 1_703_000_000_000);
  assert.equal(snapshot.payments[0]?.status, "succeeded");
  assert.equal(snapshot.payments[0]?.stripeInvoiceId, "in_1");
  assert.equal(snapshot.entitlements.length, 1);
  assert.equal(snapshot.roleAssignments[0]?.status, "pending");
  assert.equal(
    snapshot.roleAssignments.every((row) => row.guildId === "guild_1"),
    true,
  );
  assert.equal(calls.length, 7);
  assert.equal(
    calls.every((call) => call.startsWith("acct_1:")),
    true,
  );
  assert.ok(calls.some((call) => call.includes("expand[]=data.latest_invoice")));
  assert.ok(calls.some((call) => call.includes("expand[]=data.payments")));
  assert.equal(
    calls.some((call) =>
      call.includes("data.latest_invoice.payment_intent.latest_charge.balance_transaction"),
    ),
    false,
    "subscription expansion must stay within Stripe's four-level limit",
  );
  database.close();
});

test("requeues a removed role assignment when its paid entitlement recovers", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  database.d1
    .prepare(
      `INSERT INTO commerce_entitlements(
         id, connected_account_id, buyer_id, offering_id, source_type, source_id,
         status, effective_at_ms, revoked_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "entitlement_recovery",
      "acct_1",
      "buyer_1",
      "offering_1",
      "subscription",
      "sub_1",
      "revoked",
      NOW,
      NOW,
      NOW,
      NOW,
    )
    .run();
  database.d1
    .prepare(
      `INSERT INTO commerce_role_assignments(
         id, entitlement_id, guild_id, discord_user_id, discord_role_id, status,
         removed_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "role_recovery",
      "entitlement_recovery",
      "guild_1",
      "discord_1",
      "role_1",
      "removed",
      NOW,
      NOW,
      NOW,
    )
    .run();

  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    now: () => NOW,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        return response(path);
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: { eventType: "invoice.paid", objectId: "pi_1", source: "webhook" },
  });

  assert.equal(snapshot.entitlements[0]?.status, "active");
  assert.equal(snapshot.roleAssignments[0]?.status, "pending");
  assert.equal(snapshot.roleAssignments[0]?.removedAtMs, null);
  database.close();
});

test("quarantines unknown price and buyer correlations", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        return path.includes("customers")
          ? { data: [{ id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } }] }
          : path.includes("subscriptions")
            ? {
                data: [
                  {
                    id: "sub_1",
                    customer: "cus_1",
                    status: "active",
                    metadata: { haf_offering_id: "offering_1" },
                    items: {
                      data: [
                        {
                          price: {
                            id: "price_unknown",
                            product: "prod_unknown",
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : { data: [] };
      },
    },
  });
  await assert.rejects(
    () =>
      provider.readSellerSnapshot({
        connectedAccountId: "acct_1",
        trigger: {
          eventType: "customer.subscription.updated",
          objectId: "sub_1",
          source: "webhook",
        },
      }),
    (error: unknown) =>
      error instanceof CommerceProjectionQuarantineError &&
      error.reasonCode === "unknown_commerce_price",
  );
  database.close();
});

test("paginates each seller-scoped Stripe collection and leaves unpaid subscriptions pending", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  const calls: string[] = [];
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    now: () => NOW,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        calls.push(path);
        if (path.includes("customers") && !path.includes("starting_after")) {
          return {
            data: [{ id: "cus_page_1", metadata: { haf_buyer_id: "buyer_1" } }],
            has_more: true,
          };
        }
        if (path.includes("customers") && path.includes("starting_after")) {
          return {
            data: [{ id: "cus_page_2", metadata: { haf_buyer_id: "buyer_1" } }],
            has_more: false,
          };
        }
        if (path.includes("subscriptions")) {
          return {
            data: [
              {
                id: "sub_unpaid",
                customer: "cus_page_1",
                status: "active",
                latest_invoice: { paid: false, status: "open" },
                items: {
                  data: [{ price: { id: "price_1", product: "prod_1" } }],
                },
              },
            ],
            has_more: false,
          };
        }
        return { data: [], has_more: false };
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: {
      eventType: "customer.subscription.updated",
      objectId: "sub_unpaid",
      source: "scheduled",
    },
  });
  assert.equal(snapshot.subscriptions[0]?.status, "active");
  assert.equal(snapshot.entitlements[0]?.status, "pending");
  assert.equal(snapshot.roleAssignments[0]?.status, "removed");
  assert.equal(calls.filter((path) => path.includes("customers")).length, 2);
  assert.ok(calls.some((path) => path.includes("starting_after=cus_page_1")));
  database.close();
});

test("projects support payments and matched application-fee refunds without creating entitlements", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  database.d1
    .prepare(
      `INSERT INTO commerce_support_checkout_attempts(
         id, connected_account_id, guild_id, buyer_id, currency, amount_minor,
         application_fee_minor, stripe_checkout_session_id, status, expires_at_ms,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'returned', ?, ?, ?)`,
    )
    .bind(
      "support_attempt_1",
      "acct_1",
      "guild_1",
      "buyer_1",
      "AUD",
      2_000,
      100,
      "cs_support_1",
      NOW + 60_000,
      NOW,
      NOW,
    )
    .run();
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    now: () => NOW,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        if (path.includes("customers")) {
          return {
            data: [{ id: "cus_support", metadata: { haf_buyer_id: "buyer_1" } }],
          };
        }
        if (path.includes("payment_intents")) {
          return {
            data: [
              {
                id: "pi_support",
                customer: "cus_support",
                status: "succeeded",
                currency: "aud",
                amount: 2_000,
                amount_received: 2_000,
                amount_refunded: 500,
                created: 1_700_000_000,
                latest_charge: {
                  id: "ch_support",
                  amount_refunded: 500,
                  balance_transaction: {
                    fee: 88,
                    fee_details: [
                      { type: "stripe_fee", amount: 88 },
                      { type: "tax", amount: 12 },
                    ],
                  },
                },
                metadata: {
                  haf_checkout_kind: "support",
                  haf_buyer_id: "buyer_1",
                  haf_guild_id: "guild_1",
                  haf_checkout_attempt_id: "support_attempt_1",
                  haf_application_fee_minor: "100",
                },
              },
            ],
          };
        }
        if (path.includes("/v1/refunds")) {
          return {
            data: [
              {
                id: "re_support",
                payment_intent: "pi_support",
                currency: "aud",
                amount: 500,
                status: "succeeded",
                created: 1_700_100_000,
              },
            ],
          };
        }
        if (path.includes("application_fees")) {
          return {
            data: [
              {
                id: "fee_support",
                charge: "ch_support",
                amount: 100,
                refunds: { data: [{ id: "fee_re_support", amount: 25 }] },
              },
            ],
          };
        }
        if (path.includes("disputes")) {
          return {
            data: [
              {
                id: "dp_support",
                payment_intent: "pi_support",
                currency: "aud",
                amount: 2_000,
                status: "needs_response",
                reason: "fraudulent",
                created: 1_700_200_000,
              },
            ],
          };
        }
        return { data: [] };
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: {
      eventType: "charge.refunded",
      objectId: "re_support",
      source: "webhook",
    },
  });
  assert.equal(snapshot.payments.length, 0);
  assert.equal(snapshot.entitlements.length, 0);
  assert.equal(snapshot.roleAssignments.length, 0);
  assert.equal(snapshot.supportPayments?.[0]?.applicationFeeMinor, 100);
  assert.equal(snapshot.supportPayments?.[0]?.stripeFeeMinor, 88);
  assert.equal(snapshot.supportPayments?.[0]?.stripeFeeTaxMinor, 12);
  assert.equal(snapshot.supportRefunds?.[0]?.applicationFeeRefundedMinor, 25);
  assert.equal(snapshot.supportDisputes?.[0]?.supportPaymentId, snapshot.supportPayments?.[0]?.id);
  assert.equal(snapshot.supportDisputes?.[0]?.status, "needs_response");
  assert.equal(snapshot.disputes.length, 0);
  database.close();
});

test("projects metadata-free initial and renewal invoices, including fee tax and fee reversal", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        if (path.includes("customers")) {
          return { data: [{ id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } }] };
        }
        if (path.includes("subscriptions")) {
          return {
            data: [
              {
                id: "sub_1",
                customer: "cus_1",
                status: "active",
                latest_invoice: { id: "in_renewal", status: "paid", payment_intent: "pi_renewal" },
                items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
              },
            ],
          };
        }
        if (path.includes("invoices")) {
          return {
            data: [
              invoice("in_initial", "pi_initial", 1_700_000_000, 1_703_000_000),
              invoice("in_renewal", "pi_renewal", 1_703_000_000, 1_705_592_000),
            ],
          };
        }
        if (path.includes("payment_intents")) {
          return {
            data: [
              paymentIntent("pi_initial", "cus_1", "ch_initial"),
              paymentIntent("pi_renewal", "cus_1", "ch_renewal"),
              { id: "pi_unrelated", customer: "cus_other", status: "succeeded" },
            ],
          };
        }
        if (path.includes("/v1/refunds")) {
          return {
            data: [
              {
                id: "re_initial_without_fee_refund_list",
                payment_intent: "pi_initial",
                currency: "aud",
                amount: 50,
                status: "succeeded",
              },
              {
                id: "re_renewal",
                payment_intent: "pi_renewal",
                currency: "aud",
                amount: 200,
                status: "succeeded",
              },
              {
                id: "re_renewal_without_fee_reversal",
                payment_intent: "pi_renewal",
                currency: "aud",
                amount: 100,
                status: "succeeded",
              },
            ],
          };
        }
        if (path.includes("application_fees")) {
          return {
            data: [
              {
                id: "fee_initial",
                charge: "ch_initial",
                amount: 100,
                amount_refunded: 19,
                refunds: { data: [] },
              },
              {
                id: "fee_renewal",
                charge: "ch_renewal",
                amount: 100,
                refunds: { data: [{ id: "fee_refund_renewal", amount: 17 }] },
              },
            ],
          };
        }
        return { data: [] };
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: { eventType: "invoice.paid", objectId: "in_renewal", source: "webhook" },
  });
  assert.equal(snapshot.payments.length, 2);
  assert.deepEqual(
    snapshot.payments.map((payment) => payment.stripeInvoiceId),
    ["in_initial", "in_renewal"],
  );
  assert.equal(snapshot.payments[0]?.stripeSubscriptionId, "sub_1");
  assert.equal(snapshot.payments[1]?.isLatestSubscriptionInvoice, true);
  assert.equal(snapshot.payments[0]?.billingPeriodStartMs, 1_700_000_000_000);
  assert.equal(snapshot.payments[0]?.stripeFeeTaxMinor, 11);
  assert.equal(snapshot.refunds[0]?.applicationFeeRefundedMinor, null);
  assert.equal(snapshot.refunds[1]?.applicationFeeRefundedMinor, 17);
  assert.equal(snapshot.refunds[2]?.applicationFeeRefundedMinor, null);
  database.close();
});

test("ignores unrelated seller objects and quarantines contradictory HAF metadata", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        if (path.includes("customers")) {
          return {
            data: [
              { id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } },
              { id: "cus_other", metadata: {} },
            ],
          };
        }
        if (path.includes("subscriptions")) {
          return {
            data: [
              {
                id: "sub_owned",
                customer: "cus_1",
                status: "active",
                latest_invoice: { paid: true, status: "paid" },
                items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
              },
              {
                id: "sub_other",
                customer: "cus_other",
                status: "active",
                items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
              },
            ],
          };
        }
        if (path.includes("payment_intents")) {
          return { data: [{ id: "pi_other", customer: "cus_other", status: "succeeded" }] };
        }
        if (path.includes("/v1/refunds")) {
          return { data: [{ id: "re_other", payment_intent: "pi_other", amount: 10 }] };
        }
        if (path.includes("disputes")) {
          return { data: [{ id: "dp_other", payment_intent: "pi_other", amount: 10 }] };
        }
        return { data: [] };
      },
    },
  });
  const snapshot = await provider.readSellerSnapshot({
    connectedAccountId: "acct_1",
    trigger: { eventType: "scheduled", objectId: null, source: "scheduled" },
  });
  assert.equal(snapshot.subscriptions.length, 1);
  assert.equal(snapshot.payments.length, 0);
  assert.equal(snapshot.refunds.length, 0);
  assert.equal(snapshot.disputes.length, 0);
  database.close();

  const contradictoryDatabase = await createTestDatabase();
  seed(contradictoryDatabase.d1);
  const contradictoryProvider = new StripeCommerceSnapshotProvider({
    database: contradictoryDatabase.d1,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        if (path.includes("customers")) {
          return { data: [{ id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } }] };
        }
        if (path.includes("subscriptions")) {
          return {
            data: [
              {
                id: "sub_1",
                customer: "cus_1",
                metadata: { haf_guild_id: "guild_other" },
                items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
              },
            ],
          };
        }
        return { data: [] };
      },
    },
  });
  await assert.rejects(
    () =>
      contradictoryProvider.readSellerSnapshot({
        connectedAccountId: "acct_1",
        trigger: {
          eventType: "customer.subscription.updated",
          objectId: "sub_1",
          source: "webhook",
        },
      }),
    (error: unknown) =>
      error instanceof CommerceProjectionQuarantineError &&
      error.reasonCode === "contradictory_haf_metadata",
  );
  contradictoryDatabase.close();
});

test("starts grace from a failed invoice once, clears on recovery, and restarts for a later failure", async () => {
  const database = await createTestDatabase();
  seed(database.d1);
  database.d1
    .prepare(
      `INSERT INTO commerce_subscriptions(
         id, connected_account_id, customer_id, buyer_id, offering_id, price_id,
         stripe_subscription_id, status, cancel_at_period_end, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      "sub_local",
      "acct_1",
      "customer_local",
      "buyer_1",
      "offering_1",
      "price_local_1",
      "sub_1",
      "past_due",
      NOW,
      NOW,
    )
    .run();
  let phase: "failed" | "paid" | "later-failed" = "failed";
  const provider = new StripeCommerceSnapshotProvider({
    database: database.d1,
    stripe: {
      async readConnectedAccount() {
        return account();
      },
      async requestForConnectedAccount(_id, path) {
        if (path.includes("customers")) {
          return { data: [{ id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } }] };
        }
        if (path.includes("subscriptions")) {
          return {
            data: [
              {
                id: "sub_1",
                customer: "cus_1",
                status: "past_due",
                latest_invoice: invoiceForGrace(phase),
                items: { data: [{ price: { id: "price_1", product: "prod_1" } }] },
              },
            ],
          };
        }
        if (path.includes("invoices")) return { data: [invoiceForGrace(phase)] };
        if (path.includes("payment_intents")) {
          const current = invoiceForGrace(phase);
          return {
            data: [
              {
                id: current.payment_intent,
                customer: "cus_1",
                status: phase === "paid" ? "succeeded" : "requires_payment_method",
                currency: "aud",
                amount: 1_000,
                amount_received: phase === "paid" ? 1_000 : 0,
                created: current.created,
              },
            ],
          };
        }
        return { data: [] };
      },
    },
  });
  const read = () =>
    provider.readSellerSnapshot({
      connectedAccountId: "acct_1",
      trigger: { eventType: "invoice.payment_failed", objectId: "sub_1", source: "webhook" },
    });
  const first = await read();
  assert.equal(first.subscriptions[0]?.graceStartedAtMs, 1_700_000_000_000);
  assert.equal(first.subscriptions[0]?.graceEndsAtMs, 1_700_000_000_000 + 7 * 86_400_000);

  database.d1
    .prepare(
      `UPDATE commerce_subscriptions
       SET latest_invoice_id = ?, grace_started_at_ms = ?, grace_ends_at_ms = ?
       WHERE stripe_subscription_id = ?`,
    )
    .bind("in_failed", 1_700_000_000_000, 1_700_000_000_000 + 7 * 86_400_000, "sub_1")
    .run();
  const repeated = await read();
  assert.equal(repeated.subscriptions[0]?.graceStartedAtMs, 1_700_000_000_000);

  phase = "paid";
  const recovered = await read();
  assert.equal(recovered.subscriptions[0]?.graceStartedAtMs, null);
  assert.equal(recovered.subscriptions[0]?.graceEndsAtMs, null);
  database.d1
    .prepare(
      `UPDATE commerce_subscriptions
       SET latest_invoice_id = ?, grace_started_at_ms = NULL, grace_ends_at_ms = NULL
       WHERE stripe_subscription_id = ?`,
    )
    .bind("in_recovered", "sub_1")
    .run();
  phase = "later-failed";
  const laterFailure = await read();
  assert.equal(laterFailure.subscriptions[0]?.graceStartedAtMs, 1_700_200_000_000);
  database.close();
});

function invoice(id: string, paymentIntentId: string, periodStart: number, periodEnd: number) {
  return {
    id,
    subscription: "sub_1",
    paid: true,
    status: "paid",
    currency: "aud",
    amount_paid: 1_000,
    payment_intent: paymentIntentId,
    created: periodStart,
    lines: { data: [{ period: { start: periodStart, end: periodEnd } }] },
  };
}

function invoiceForGrace(phase: "failed" | "paid" | "later-failed") {
  const paid = phase === "paid";
  const id = paid ? "in_recovered" : phase === "later-failed" ? "in_later" : "in_failed";
  const created = paid ? 1_700_100_000 : phase === "later-failed" ? 1_700_200_000 : 1_700_000_000;
  return {
    id,
    subscription: "sub_1",
    payment_intent: paid ? "pi_recovered" : phase === "later-failed" ? "pi_later" : "pi_failed",
    status: paid ? "paid" : "open",
    paid,
    currency: "aud",
    amount_paid: paid ? 1_000 : 0,
    amount_due: 1_000,
    created,
  };
}

function paymentIntent(id: string, customer: string, chargeId: string) {
  return {
    id,
    customer,
    status: "succeeded",
    currency: "aud",
    amount: 1_000,
    amount_received: 1_000,
    latest_charge: {
      id: chargeId,
      balance_transaction: {
        fee: 88,
        fee_details: [{ type: "tax", amount: 11 }],
      },
    },
    created: 1_700_000_000,
  };
}

function account() {
  return {
    id: "acct_1",
    country: "AU",
    defaultCurrency: "aud",
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    disabledReason: null,
    currentlyDue: [],
    eventuallyDue: [],
    pendingVerification: [],
    providerCreatedAtMs: NOW,
    state: {
      capabilities: {},
      requirements: {
        currentlyDue: [],
        eventuallyDue: [],
        pastDue: [],
        pendingVerification: [],
        errors: [],
        disabledReason: null,
        currentDeadlineMs: null,
      },
    },
  };
}
function response(path: string) {
  if (path.includes("customers"))
    return { data: [{ id: "cus_1", metadata: { haf_buyer_id: "buyer_1" } }] };
  if (path.includes("subscriptions"))
    return {
      data: [
        {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          latest_invoice: {
            id: "in_1",
            paid: true,
            status: "paid",
            payment_intent: "pi_1",
          },
          start_date: 1_700_000_000,
          items: {
            data: [
              {
                current_period_start: 1_700_000_000,
                current_period_end: 1_703_000_000,
                price: { id: "price_1", product: "prod_1" },
              },
            ],
          },
        },
      ],
    };
  if (path.includes("invoices"))
    return {
      data: [
        {
          id: "in_1",
          subscription: "sub_1",
          status: "paid",
          currency: "aud",
          amount_paid: 1000,
          payments: {
            data: [
              {
                id: "inpay_1",
                status: "paid",
                amount_paid: 1000,
                payment: { type: "payment_intent", payment_intent: "pi_1" },
              },
            ],
          },
          created: 1_700_000_000,
          lines: { data: [{ period: { start: 1_700_000_000, end: 1_703_000_000 } }] },
        },
      ],
    };
  if (path.includes("payment_intents"))
    return {
      data: [
        {
          id: "pi_1",
          customer: "cus_1",
          status: "succeeded",
          currency: "aud",
          amount: 1000,
          amount_received: 1000,
          amount_refunded: 0,
          created: 1_700_000_000,
        },
      ],
    };
  return { data: [] };
}
function seed(database: D1Database) {
  database
    .prepare(
      "INSERT INTO commerce_connected_accounts (id,guild_id,stripe_account_id,status,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind("acct_1", "guild_1", "acct_1", "active", 1, 1, 1, NOW, NOW)
    .run();
  database
    .prepare(
      "INSERT INTO commerce_offerings (id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "offering_1",
      "acct_1",
      "guild_1",
      "role_1",
      "Offering",
      "subscription",
      "active",
      NOW,
      NOW,
    )
    .run();
  database
    .prepare(
      "INSERT INTO commerce_prices (id,connected_account_id,offering_id,stripe_product_id,stripe_price_id,currency,unit_amount_minor,price_type,recurring_interval,status,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      "price_local_1",
      "acct_1",
      "offering_1",
      "prod_1",
      "price_1",
      "AUD",
      1000,
      "recurring",
      "month",
      "active",
      NOW,
    )
    .run();
  database
    .prepare(
      "INSERT INTO commerce_buyers (id,discord_user_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?)",
    )
    .bind("buyer_1", "discord_1", NOW, NOW)
    .run();
}

test("reserved capacity expiry requires a provider-confirmed terminal session, not local timeout", async () => {
  const database = await createTestDatabase();
  try {
    seed(database.d1);
    await database.d1
      .prepare(
        `INSERT INTO commerce_checkout_attempts(id,connected_account_id,guild_id,offering_id,price_id,buyer_id,stripe_checkout_session_id,status,expires_at_ms,created_at_ms,updated_at_ms) VALUES('checkout','acct_1','guild_1','offering_1','price_local_1','buyer_1','cs_fixture','expired',1,1,1)`,
      )
      .run();
    await database.d1
      .prepare(
        "INSERT INTO commerce_game_selections(checkout_id,offering_id,buyer_id,assignment_id,data) VALUES('checkout','offering_1','buyer_1','assignment','{}')",
      )
      .run();
    let mode = "open";
    const provider = new StripeCommerceSnapshotProvider({
      database: database.d1,
      now: () => NOW,
      stripe: {
        readConnectedAccount: async () => account(),
        requestForConnectedAccount: async (id, path) => {
          assert.equal(id, "acct_1");
          if (path.includes("/checkout/sessions/")) {
            if (mode === "outage") throw new Error("private Stripe error");
            return {
              id: "cs_fixture",
              mode: "subscription",
              status: mode,
              payment_status: "unpaid",
            };
          }
          return response(path);
        },
      },
    });
    const input = {
      connectedAccountId: "acct_1",
      trigger: { eventType: "scheduled", objectId: "acct_1", source: "scheduled" as const },
    };
    assert.deepEqual((await provider.readSellerSnapshot(input)).expiredCheckoutIds, []);
    mode = "outage";
    const pending = await provider.readSellerSnapshot(input);
    assert.deepEqual(pending.expiredCheckoutIds, []);
    assert.equal(pending.subscriptions[0].status, "active");
    mode = "expired";
    assert.deepEqual((await provider.readSellerSnapshot(input)).expiredCheckoutIds, ["checkout"]);
  } finally {
    database.close();
  }
});
