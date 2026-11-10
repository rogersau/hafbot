/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  isValidStripeSecretKey,
  parseConnectedAccountState,
  StripeConnectClient,
} from "../src/runtime/commerce/stripe-connect-client";

const account = {
  id: "acct_seller",
  country: "AU",
  charges_enabled: true,
  payouts_enabled: false,
  details_submitted: true,
  default_currency: "aud",
  created: 1_700_000_000,
  capabilities: { card_payments: "active", transfers: "pending", bad: "bogus" },
  requirements: {
    currently_due: ["individual.verification.document"],
    eventually_due: ["business_profile.url"],
    past_due: [],
    pending_verification: ["external_account"],
    disabled_reason: "requirements.past_due",
    current_deadline: 1_800_000_000,
    errors: [
      {
        code: "verification_failed",
        reason: "Document could not be verified",
        requirement: "individual.verification.document",
        person: { id: "person_secret" },
      },
    ],
  },
  individual: { id: "person_secret" },
  external_accounts: { data: [{ id: "ba_secret" }] },
};

function client(
  responses: unknown[],
  requests: Array<{ url: string; init?: RequestInit }>,
): StripeConnectClient {
  return new StripeConnectClient(
    "sk_test_never_print_fixture",
    "2026-06-24.dahlia",
    async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift() ?? {});
    },
  );
}

test("Stripe Connect client rejects malformed secret keys without echoing them", () => {
  for (const secretKey of ["not-a-stripe-secret", "sk_test_short"]) {
    assert.throws(
      () => new StripeConnectClient(secretKey, "2026-06-24.dahlia"),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "Stripe Connect configuration is invalid." &&
        !error.message.includes(secretKey),
    );
  }
});

test("Stripe secret-key validation can enforce the active environment", () => {
  assert.equal(isValidStripeSecretKey("sk_test_runtime_key_material", "test"), true);
  assert.equal(isValidStripeSecretKey("sk_test_runtime_key_material", "live"), false);
  assert.equal(isValidStripeSecretKey("sk_live_runtime_key_material", "live"), true);
  assert.equal(isValidStripeSecretKey("sk_live_runtime_key_material", "test"), false);
});

test("seller prefills reject placeholder email and non-HTTPS profile URLs before Stripe", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stripe = client([account], requests);
  const base = {
    guildId: "guild_123",
    sellerUserId: "seller_456",
    idempotencyKey: "commerce:seller:guild_123:v1",
  };

  await assert.rejects(
    stripe.createConnectedAccount({ ...base, sellerEmail: "123@discord.local" }),
    /Seller email is invalid/,
  );
  await assert.rejects(
    stripe.createConnectedAccount({
      ...base,
      businessProfileUrl: "http://haf.test/commerce/stores/guild_123",
    }),
    /Seller business profile URL is invalid/,
  );
  assert.equal(requests.length, 0);
});

test("platform account creation uses the validated seller configuration and metadata", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stripe = client([account], requests);
  const result = await stripe.createConnectedAccount({
    guildId: "guild_123",
    sellerUserId: "seller_456",
    sellerEmail: "owner@example.test",
    businessProfileUrl: "https://haf.test/commerce/stores/guild_123",
    environment: "staging",
    idempotencyKey: "commerce:seller:guild_123:v1",
  });
  const body = new URLSearchParams(String(requests[0]?.init?.body));
  assert.equal(result.id, "acct_seller");
  assert.equal(requests[0]?.url, "https://api.stripe.com/v1/accounts");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)?.["stripe-account"],
    undefined,
  );
  assert.equal(body.get("country"), "AU");
  assert.equal(body.get("controller[fees][payer]"), "account");
  assert.equal(body.get("controller[losses][payments]"), "stripe");
  assert.equal(body.get("controller[requirement_collection]"), "stripe");
  assert.equal(body.get("controller[stripe_dashboard][type]"), "full");
  assert.equal(body.get("metadata[haf_guild_id]"), "guild_123");
  assert.equal(body.get("metadata[haf_seller_id]"), "seller_456");
  assert.equal(body.get("email"), "owner@example.test");
  assert.equal(body.get("business_profile[url]"), "https://haf.test/commerce/stores/guild_123");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)?.["idempotency-key"],
    "commerce:seller:guild_123:v1",
  );
});

test("onboarding and management links are platform-scoped and validate URLs", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stripe = client(
    [{ url: "https://connect.stripe.test/onboard", expires_at: 100 }],
    requests,
  );
  const onboarding = await stripe.createOnboardingLink({
    connectedAccountId: "acct_seller",
    returnUrl: "https://haf.test/return",
    refreshUrl: "https://haf.test/refresh",
    idempotencyKey: "link:onboard:1",
  });
  assert.equal(onboarding.expiresAtMs, 100_000);
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)?.["stripe-account"],
    undefined,
  );
  const body = new URLSearchParams(String(requests[0]?.init?.body));
  assert.equal(body.get("account"), "acct_seller");
  assert.equal(body.get("type"), "account_onboarding");
  assert.equal(body.get("collection_options[fields]"), "currently_due");
  assert.equal(body.get("collection_options[future_requirements]"), "omit");

  requests.length = 0;
  const management = client([{ url: "https://connect.stripe.test/login" }], requests);
  const dashboard = await management.createAccountManagementLink({
    connectedAccountId: "acct_seller",
    idempotencyKey: "link:manage:1",
  });
  assert.equal(dashboard.url, "https://dashboard.stripe.com/");
  assert.equal(requests.length, 0, "full-Dashboard sellers must not use Express login links");
});

test("connected-account request helper requires an account and always sets Stripe-Account", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stripe = client([{ id: "pi_1" }], requests);
  await stripe.requestForConnectedAccount("acct_seller", "/v1/payment_intents/pi_1");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)?.["stripe-account"],
    "acct_seller",
  );
  await assert.rejects(
    () => stripe.requestConnectedAccount({ accountId: "", path: "/v1/payment_intents/pi_1" }),
    /Account ID is required/,
  );
});

test("account state parsing is safe and excludes identity and bank fields", () => {
  const parsed = parseConnectedAccountState(account);
  assert.deepEqual(parsed.capabilities, {
    card_payments: "active",
    transfers: "pending",
    bad: "unknown",
  });
  assert.deepEqual(parsed.requirements.currentlyDue, ["individual.verification.document"]);
  assert.equal(parsed.requirements.currentDeadlineMs, 1_800_000_000_000);
  assert.deepEqual(parsed.requirements.errors, [
    {
      code: "verification_failed",
      reason: "Document could not be verified",
      requirement: "individual.verification.document",
    },
  ]);
  assert.equal("individual" in parsed, false);
  assert.equal("external_accounts" in parsed, false);
});

test("request errors are generic and never echo the Stripe secret", async () => {
  const stripe = new StripeConnectClient(
    "sk_test_secret_should_not_escape",
    "2026-06-24.dahlia",
    async () =>
      Response.json({ error: { message: "sk_test_secret_should_not_escape" } }, { status: 400 }),
  );
  await assert.rejects(
    () => stripe.readConnectedAccount("acct_seller"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Stripe Connect request failed." &&
      !error.message.includes("sk_test_secret"),
  );
});
