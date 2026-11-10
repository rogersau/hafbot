import assert from "node:assert/strict";
import test from "node:test";

import {
  CommerceSupportService,
  type CommerceSupportStore,
} from "../src/commerce/support-payments";
import {
  createCommerceSupportRoutes,
  signCommerceSupportState,
  verifyCommerceSupportState,
} from "../src/routes/commerce-support-routes";
import { StripeCommerceSupportProvider } from "../src/runtime/commerce/stripe-support-provider";

const NOW = 1_900_000_000_000;
const SECRET = "support-state-secret";
const GUILD_ID = "111111111111111111";
const USER_ID = "222222222222222222";
const ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("support state rejects tampering, expiry, and cross-account use", async () => {
  const token = await signCommerceSupportState(state(), SECRET);
  assert.deepEqual(await verifyCommerceSupportState(token, SECRET, NOW), state());
  assert.equal(await verifyCommerceSupportState(`${token}x`, SECRET, NOW), null);
  assert.equal(await verifyCommerceSupportState(token, "wrong", NOW), null);
  assert.equal(await verifyCommerceSupportState(token, SECRET, NOW + 31 * 60_000), null);
});

test("support checkout requires same origin and fixes return URLs", async () => {
  let received: any;
  const service = {
    async startCheckout(input: unknown) {
      received = input;
      return { checkoutSessionId: "cs_1", url: "https://checkout.stripe.com/c/pay/support" };
    },
  } as unknown as CommerceSupportService;
  const handler = routes(service);
  const token = await signCommerceSupportState(state(), SECRET);
  const csrf = await handler(post(token, "https://attacker.example"));
  assert.equal(csrf?.status, 403);
  const response = await handler(post(token));
  assert.equal(response?.status, 303);
  assert.equal(response?.headers.get("location"), "https://checkout.stripe.com/c/pay/support");
  assert.equal(received.amountMinor, 2_000);
  assert.match(received.successUrl, /^https:\/\/hafbot\.xyz\/commerce\/support\/return\?state=/);
  assert.equal(
    received.cancelUrl,
    `https://hafbot.xyz/commerce/support/${GUILD_ID}?checkout=cancelled`,
  );
});

test("support checkout sends custom currency amounts and preset cents to Stripe unchanged", async (t) => {
  for (const currency of ["AUD", "USD"] as const) {
    for (const { fields, expectedMinor } of [
      { fields: { custom_amount: "10" }, expectedMinor: 1_000 },
      { fields: { custom_amount: "200" }, expectedMinor: 20_000 },
      { fields: { custom_amount: "500" }, expectedMinor: 50_000 },
      { fields: { custom_amount: "200.00" }, expectedMinor: 20_000 },
      { fields: { custom_amount: "10.2" }, expectedMinor: 1_020 },
      { fields: { custom_amount: "2.00" }, expectedMinor: 200 },
      { fields: { amount: "200" }, expectedMinor: 200 },
      { fields: { amount: "200", custom_amount: "" }, expectedMinor: 200 },
      { fields: { amount: "200", custom_amount: "10" }, expectedMinor: 1_000 },
    ]) {
      await t.test(`${currency} ${JSON.stringify(fields)}`, async () => {
        const { handler, checkoutBodies } = checkoutHarness(currency);
        const token = await signCommerceSupportState(state(), SECRET);
        const response = await handler(post(token, "https://hafbot.xyz", fields));
        assert.equal(response?.status, 303);
        assert.equal(checkoutBodies.length, 1);
        assert.equal(
          checkoutBodies[0]?.get("line_items[0][price_data][unit_amount]"),
          String(expectedMinor),
        );
        assert.equal(
          checkoutBodies[0]?.get("payment_intent_data[application_fee_amount]"),
          String(expectedMinor / 20),
        );
        assert.equal(
          checkoutBodies[0]?.get("line_items[0][price_data][currency]"),
          currency.toLowerCase(),
        );
      });
    }
  }
});

test("support checkout rejects invalid amounts before creating a Stripe checkout", async (t) => {
  for (const fields of [
    {},
    { custom_amount: "" },
    ...[
      "10abc",
      "1e2",
      "10.001",
      "10.",
      ".20",
      "+10",
      "-10",
      "0xC8",
      "NaN",
      "Infinity",
      "9007199254740993",
    ].map((custom_amount) => ({ amount: "200", custom_amount })),
    ...["1.80", "500.20", "10.01", "10.10"].map((custom_amount) => ({ custom_amount })),
    ...["200.00", "2e2", "200junk", "9007199254740993", "199", "201", "50001"].map((amount) => ({
      amount,
    })),
  ]) {
    await t.test(JSON.stringify(fields), async () => {
      const { handler, checkoutBodies } = checkoutHarness();
      const token = await signCommerceSupportState(state(), SECRET);
      const response = await handler(post(token, "https://hafbot.xyz", fields));
      assert.equal(response?.status, 409);
      const html = await response!.text();
      assert.match(html, /2\.00 through 500\.00/);
      assert.match(html, /0\.20 increments/);
      assert.doesNotMatch(html, /exact five-percent fee/);
      assert.equal(checkoutBodies.length, 0);
    });
  }
});

test("public support page states the non-recurring no-benefit boundary", async () => {
  const handler = routes({
    async page() {
      return page();
    },
  } as unknown as CommerceSupportService);
  const response = await handler(
    new Request(`https://hafbot.xyz/commerce/support/${GUILD_ID}`, { method: "GET" }),
  );
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("referrer-policy"), "strict-origin");
  assert.match(response?.headers.get("cache-control") ?? "", /private, no-store/);
  const html = await response?.text();
  assert.match(html ?? "", /one-time, non-recurring/i);
  assert.match(html ?? "", /no exclusive Discord role/i);
  assert.match(html ?? "", /not a charitable donation/i);
  assert.match(html ?? "", /applicable consumer law/i);
  assert.match(html ?? "", /HAF Bot facilitates payment/i);
  assert.match(html ?? "", /AUD 2\.00–500\.00 in 0\.20 increments/);
  assert.match(html ?? "", /A custom amount replaces the selected suggested amount/);
  assert.match(
    html ?? "",
    /name="custom_amount" type="number" inputmode="decimal" min="2" max="500" step="0\.20"/,
  );
  assert.match(html ?? "", /aria-describedby="support-amount-hint"/);
});

function checkoutHarness(currency: "AUD" | "USD" = "AUD") {
  const supportPage = page();
  supportPage.config.currency = currency;
  const checkoutBodies: URLSearchParams[] = [];
  const store: CommerceSupportStore = {
    async readConfigByGuild() {
      return supportPage.config;
    },
    async readContextByGuild() {
      return supportPage.context;
    },
    async saveConfig() {},
    async getOrCreateBuyer() {
      return { id: "buyer_1", discordUserId: USER_ID, createdAtMs: NOW, updatedAtMs: NOW };
    },
    async readCustomer() {
      return {
        id: "customer_1",
        connectedAccountId: "acct_1",
        buyerId: "buyer_1",
        stripeCustomerId: "cus_1",
        createdAtMs: NOW,
        updatedAtMs: NOW,
      };
    },
    async saveCustomer() {},
    async claimRateLimit() {
      return true;
    },
    async reserveCheckout() {
      return true;
    },
    async attachCheckoutSession() {},
    async failCheckout() {},
    async markCheckoutReturned() {
      return null;
    },
    async readPaymentStatus() {
      return null;
    },
    async readPayment() {
      return null;
    },
    async readReport() {
      return [];
    },
  };
  const provider = new StripeCommerceSupportProvider({
    async requestForConnectedAccount(accountId, path, options = {}) {
      assert.equal(accountId, "acct_1");
      assert.equal(path, "/v1/checkout/sessions");
      assert.ok(options.body instanceof URLSearchParams);
      checkoutBodies.push(options.body);
      return { id: "cs_1", url: "https://checkout.stripe.com/c/pay/support" };
    },
  });
  const service = new CommerceSupportService(
    store,
    provider,
    { async request() {} },
    supportPage.config.termsVersion,
    () => NOW,
  );
  return { handler: routes(service), checkoutBodies };
}

function routes(service: CommerceSupportService) {
  return createCommerceSupportRoutes({
    service,
    signingSecret: SECRET,
    publicBaseUrl: "https://hafbot.xyz",
    async readSession() {
      return { user: { id: "auth-user", discordUserId: USER_ID, name: "Buyer" } };
    },
    async readMember() {
      return { present: true, bot: false, banned: false };
    },
    async readGuildName() {
      return "Test Guild";
    },
    now: () => NOW,
    createId: () => ATTEMPT_ID,
  });
}

function post(
  token: string,
  origin = "https://hafbot.xyz",
  fields: Record<string, string | undefined> = { amount: "2000" },
): Request {
  const body = new URLSearchParams({ state: token });
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value);
  }
  return new Request("https://hafbot.xyz/commerce/support/checkout", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function state() {
  return {
    version: 1 as const,
    guildId: GUILD_ID,
    discordUserId: USER_ID,
    checkoutAttemptId: ATTEMPT_ID,
    expiresAtMs: NOW + 20 * 60_000,
  };
}

function page(): any {
  return {
    config: {
      connectedAccountId: "acct_1",
      guildId: GUILD_ID,
      enabled: true,
      explanation: "Helps cover ordinary tools and services used to operate this community.",
      currency: "AUD",
      suggestedAmountsMinor: [500, 1_000, 2_000],
      supportContact: "seller@example.test",
      termsVersion: "seller-terms-2026-07",
    },
    context: {
      account: {
        id: "acct_1",
        stripeAccountId: "acct_1",
        status: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      },
      seller: { lifecycleState: "active", approvalState: "approved" },
      premiumActive: true,
      termsAccepted: true,
      suspended: false,
    },
  };
}
