import assert from "node:assert/strict";
import test from "node:test";

import type { CommerceBuyerCheckoutService } from "../src/commerce/buyer-checkout";
import {
  createCommerceBuyerRoutes,
  signCommercePurchaseState,
  verifyCommercePurchaseState,
} from "../src/routes/commerce-buyer-routes";

const NOW = 1_900_000_000_000;
const SECRET = "commerce-state-secret";
const OFFERING_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("purchase state rejects tampering, expiry and excessive lifetime", async () => {
  const token = await signCommercePurchaseState(state(), SECRET);
  assert.deepEqual(await verifyCommercePurchaseState(token, SECRET, NOW), state());
  assert.equal(await verifyCommercePurchaseState(`${token}x`, SECRET, NOW), null);
  assert.equal(await verifyCommercePurchaseState(token, "wrong-secret", NOW), null);
  assert.equal(await verifyCommercePurchaseState(token, SECRET, NOW + 31 * 60_000), null);
  const long = await signCommercePurchaseState(
    { ...state(), expiresAtMs: NOW + 31 * 60_000 },
    SECRET,
  );
  assert.equal(await verifyCommercePurchaseState(long, SECRET, NOW), null);
});

test("checkout blocks cross-account state and cross-seller substitution", async () => {
  let starts = 0;
  const fake = fakeService();
  fake.startSubscriptionCheckout = async () => {
    starts += 1;
    return { checkoutSessionId: "cs_test", url: "https://checkout.stripe.com/c/pay/test" };
  };
  const handler = routes(fake, "999999999999999999");
  const token = await signCommercePurchaseState(state(), SECRET);
  const wrongAccount = await handler(post("/commerce/checkout", token));
  assert.equal(wrongAccount?.status, 403);
  assert.equal(starts, 0);

  const scoped = routes(
    {
      ...fake,
      async storefront() {
        return storefront("999999999999999999");
      },
    },
    "123456789012345678",
  );
  const wrongSeller = await scoped(post("/commerce/checkout", token));
  assert.equal(wrongSeller?.status, 403);
  assert.equal(starts, 0);
});

test("checkout requires same-origin POST and redirects only to provider result", async () => {
  let received: any;
  const fake = fakeService();
  fake.startSubscriptionCheckout = async (input: any) => {
    received = input;
    return { checkoutSessionId: "cs_test", url: "https://checkout.stripe.com/c/pay/test" };
  };
  const handler = routes(fake, "123456789012345678");
  const token = await signCommercePurchaseState(state(), SECRET);

  const csrf = await handler(post("/commerce/checkout", token, "https://attacker.example"));
  assert.equal(csrf?.status, 403);

  const response = await handler(post("/commerce/checkout", token));
  assert.equal(response?.status, 303);
  assert.equal(response?.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
  assert.match(received.successUrl, /^https:\/\/hafbot\.xyz\/commerce\/return\?state=/);
  assert.equal(
    received.cancelUrl,
    `https://hafbot.xyz/commerce/offers/${OFFERING_ID}?checkout=cancelled`,
  );
});

test("checkout return remains valid through the Stripe Checkout lifetime", async () => {
  let currentTime = NOW;
  let successUrl = "";
  let returns = 0;
  const fake = fakeService();
  fake.startSubscriptionCheckout = async (input: any) => {
    successUrl = input.successUrl;
    return { checkoutSessionId: "cs_test", url: "https://checkout.stripe.com/c/pay/test" };
  };
  fake.handleBrowserReturn = async () => {
    returns += 1;
    return {
      customerExists: true,
      entitlementStatus: "active",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEndMs: null,
      graceEndsAtMs: null,
    };
  };
  const handler = routes(fake, "123456789012345678", () => currentTime);
  const purchaseToken = await signCommercePurchaseState(state(), SECRET);

  const checkout = await handler(post("/commerce/checkout", purchaseToken));
  assert.equal(checkout?.status, 303);

  currentTime = NOW + 32 * 60_000;
  const checkoutReturn = await handler(new Request(successUrl));
  assert.equal(checkoutReturn?.status, 200);
  assert.equal(returns, 1);
});

test("storefront preserves a usable same-origin POST without exposing signed URLs", async () => {
  const response = await routes(
    fakeService(),
    "123456789012345678",
  )(new Request(`https://hafbot.xyz/commerce/offers/${OFFERING_ID}`));

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("referrer-policy"), "strict-origin");
  assert.match(response?.headers.get("cache-control") ?? "", /private, no-store/);
  assert.match(
    response?.headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/billing\.stripe\.com https:\/\/checkout\.stripe\.com/,
  );
  assert.match(response?.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  const html = await response?.text();
  assert.match(
    html ?? "",
    /@media\(max-width:960px\)\{\.commerce-grid\{grid-template-columns:1fr\}\}/,
  );
  assert.match(html ?? "", /\.commerce-content\{display:grid;gap:18px;margin-top:18px\}/);
  assert.ok(
    (html ?? "").indexOf("Your current status") < (html ?? "").indexOf("Before you subscribe"),
  );
});

test("public guild storefront renders branded eligible offering cards without sign-in", async () => {
  const response = await routes(
    {
      ...fakeService(),
      async storefrontsForGuild() {
        return [storefront("111111111111111111")];
      },
    },
    "123456789012345678",
    () => NOW,
    {
      guildName: "Test Guild",
      guildIconUrl: null,
      accentColor: 0x12abef,
      tagline: "<safe welcome>",
    },
  )(new Request("https://hafbot.xyz/commerce/stores/111111111111111111"));

  assert.equal(response?.status, 200);
  const html = await response?.text();
  assert.match(html ?? "", /Test Guild Store/);
  assert.match(html ?? "", /VIP/);
  assert.match(html ?? "", /&lt;safe welcome&gt;/);
  assert.match(html ?? "", /Before you pay/);
  assert.match(html ?? "", /Stripe processes card/);
  assert.doesNotMatch(html ?? "", /state=/);
});

test("buyer status shows dated cancellation and payment recovery without implying role delivery", async () => {
  const fake = fakeService();
  fake.buyerStatus = async () => ({
    customerExists: true,
    entitlementStatus: "active",
    subscriptionStatus: "past_due",
    cancelAtPeriodEnd: true,
    currentPeriodEndMs: Date.UTC(2030, 2, 4, 18, 30),
    graceEndsAtMs: Date.UTC(2030, 2, 6, 18, 30),
    roleDeliveryStatus: "pending",
    gameAccess: { state: "needs-attention", reason: "provider_unavailable" },
  });
  const response = await routes(
    fake,
    "123456789012345678",
  )(new Request(`https://hafbot.xyz/commerce/offers/${OFFERING_ID}`));
  const html = await response!.text();
  assert.match(html, /Cancellation takes effect <time datetime="2030-03-04T18:30:00.000Z">/);
  assert.match(html, /4 March 2030/);
  assert.match(html, /UTC<\/time>/);
  assert.match(
    html,
    /Update your payment method before <time datetime="2030-03-06T18:30:00.000Z">/,
  );
  assert.match(html, /Access eligibility:/);
  assert.match(html, /Discord role delivery: <strong>pending<\/strong>/);
  assert.match(html, /Reserved access: <strong>needs-attention<\/strong>\. provider unavailable/);
  assert.match(html, /Server list membership does not guarantee admission/);
  assert.doesNotMatch(html, /role has been (added|delivered)/);
});

test("checkout return gives plain-language progress and links back to Discord", async () => {
  const fake = fakeService();
  fake.handleBrowserReturn = async () => ({
    customerExists: true,
    entitlementStatus: "active",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEndMs: NOW + 30 * 86_400_000,
    graceEndsAtMs: null,
  });
  const handler = routes(fake, "123456789012345678");
  const token = await signCommercePurchaseState(state(), SECRET);
  const response = await handler(new Request(`https://hafbot.xyz/commerce/return?state=${token}`));
  const html = await response!.text();
  assert.equal(response!.status, 200);
  assert.match(html, /Your Discord role may take a moment to appear/);
  assert.match(html, /Check latest status/);
  assert.match(html, /href="https:\/\/discord.com\/channels\/111111111111111111"/);
  assert.match(html, /Current paid period ends/);
  assert.doesNotMatch(html, /reconcil/);
});

function routes(
  service: any,
  discordUserId: string,
  now: () => number = () => NOW,
  branding?: {
    guildName: string;
    guildIconUrl: string | null;
    accentColor: number;
    tagline: string;
  },
) {
  return createCommerceBuyerRoutes({
    service,
    signingSecret: SECRET,
    publicBaseUrl: "https://hafbot.xyz",
    async readSession() {
      return {
        user: { id: "auth-user", discordUserId, name: "Buyer" },
      };
    },
    async readMember() {
      return { present: true, bot: false, banned: false };
    },
    async roleManageable() {
      return true;
    },
    async readPresentation() {
      return { guildName: "Test Guild", roleName: "VIP" };
    },
    readBranding: branding ? async () => branding : undefined,
    now,
    createId: () => ATTEMPT_ID,
  });
}

function post(path: string, token: string, origin = "https://hafbot.xyz"): Request {
  const body = new URLSearchParams({ state: token });
  return new Request(`https://hafbot.xyz${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function state() {
  return {
    version: 1 as const,
    offeringId: OFFERING_ID,
    guildId: "111111111111111111",
    discordUserId: "123456789012345678",
    checkoutAttemptId: ATTEMPT_ID,
    expiresAtMs: NOW + 20 * 60_000,
  };
}

function fakeService(): CommerceBuyerCheckoutService {
  return {
    async storefront() {
      return storefront("111111111111111111");
    },
    async buyerStatus() {
      return {
        customerExists: false,
        entitlementStatus: null,
        subscriptionStatus: null,
        cancelAtPeriodEnd: false,
        currentPeriodEndMs: null,
        graceEndsAtMs: null,
      };
    },
    async startSubscriptionCheckout() {
      throw new Error("not implemented");
    },
  } as unknown as CommerceBuyerCheckoutService;
}

function storefront(guildId: string): any {
  return {
    offering: {
      id: OFFERING_ID,
      connectedAccountId: "acct_seller",
      guildId,
      discordRoleId: "222222222222222222",
      name: "VIP",
      purchaseType: "subscription",
      state: "published",
      roleManageable: true,
      includedBenefits: ["VIP channels"],
      supportContact: "seller@example.com",
    },
    price: {
      currency: "AUD",
      unitAmountMinor: 500,
      recurringInterval: "month",
    },
    seller: { supportContact: "seller@example.com" },
    publishContext: {
      premiumActive: true,
      sellerEligible: true,
      termsAccepted: true,
      roleManageable: true,
    },
  };
}

test("reserved checkout presents a linking route for zero identities and requires a choice for several", async () => {
  const fake = fakeService();
  fake.storefront = async () => {
    const sf = storefront("111111111111111111");
    return {
      ...sf,
      reservedAccess: { acceptingSales: true },
      price: { ...sf.price, status: "active", priceType: "recurring" },
    };
  };
  fake.gameIdentityChoices = async () => [];
  const handler = routes(fake, "123456789012345678");
  const empty = await handler(new Request(`https://hafbot.xyz/commerce/offers/${OFFERING_ID}`));
  const emptyHtml = await empty!.text();
  assert.match(emptyHtml, /Link and authenticate Steam/);
  assert.doesNotMatch(emptyHtml, /action="\/commerce\/checkout"/);
  fake.gameIdentityChoices = async () => ["76561198000000001", "76561198000000002"];
  const many = await handler(new Request(`https://hafbot.xyz/commerce/offers/${OFFERING_ID}`));
  assert.match(await many!.text(), /name="steamId" required><option value="">Choose an account/);
});
