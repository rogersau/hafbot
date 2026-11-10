/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  CommerceSupportService,
  exactFivePercentFee,
  type CommerceSupportCheckoutAttempt,
  type CommerceSupportConfig,
  type CommerceSupportContext,
  type CommerceSupportStore,
} from "../src/commerce/support-payments";
import type { CommerceBuyer, CommerceCustomer } from "../src/commerce/types";

const NOW = 1_800_000_000_000;
const TERMS = "seller-terms-2026-07";

test("support amount policy preserves an exact five-percent fee", () => {
  assert.equal(exactFivePercentFee(500), 25);
  assert.equal(exactFivePercentFee(50_000), 2_500);
  assert.throws(() => exactFivePercentFee(201), /commerce_support_amount_rounding/);
  assert.throws(() => exactFivePercentFee(50_001), /commerce_support_amount_invalid/);
});

test("seller configuration blocks fundraising and benefit claims", async () => {
  const store = new MemorySupportStore();
  const service = supportService(store);
  await assert.rejects(
    service.saveConfig({
      guildId: "guild-1",
      enabled: false,
      explanation: "A charitable donation toward our fundraising target.",
      currency: "AUD",
      suggestedAmountsMinor: [500],
      supportContact: "seller@example.test",
    }),
    /commerce_support_prohibited_wording/,
  );
  const config = await service.saveConfig({
    guildId: "guild-1",
    enabled: true,
    explanation: "Helps cover ordinary tools and services used to operate this community.",
    currency: "AUD",
    suggestedAmountsMinor: [500, 1_000, 2_000],
    supportContact: "seller@example.test",
  });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.suggestedAmountsMinor, [500, 1_000, 2_000]);
});

test("support checkout is one-time, fee-bearing, scoped, and reconciliation-only", async () => {
  const store = new MemorySupportStore();
  store.config = config();
  const providerCalls: Array<Record<string, unknown>> = [];
  const reconciliations: Array<Record<string, unknown>> = [];
  let capacityClaimed = false;
  const service = new CommerceSupportService(
    store,
    {
      async createCustomer() {
        return { id: "cus_support" };
      },
      async createSupportCheckout(input) {
        assert.equal(capacityClaimed, true);
        providerCalls.push(input);
        return {
          id: "cs_support",
          url: "https://checkout.stripe.test/support",
        };
      },
      async createRefund() {
        return { id: "re_support" };
      },
    },
    {
      async request(input) {
        reconciliations.push(input);
      },
    },
    TERMS,
    () => NOW,
    () => "customer-local",
    {
      async claimSupport(input) {
        assert.equal(input.amountMinor, 2_000);
        capacityClaimed = true;
      },
    },
  );
  const result = await service.startCheckout({
    guildId: "guild-1",
    discordUserId: "discord-1",
    checkoutAttemptId: "11111111-1111-4111-8111-111111111111",
    amountMinor: 2_000,
    successUrl: "https://hafbot.xyz/commerce/support/return",
    cancelUrl: "https://hafbot.xyz/commerce/support/123",
    preflight: { memberPresent: true, memberIsBot: false, memberBanned: false },
  });
  assert.equal(result.checkoutSessionId, "cs_support");
  assert.equal(providerCalls[0]?.applicationFeeMinor, 100);
  assert.equal(providerCalls[0]?.amountMinor, 2_000);
  assert.equal(store.attempt?.status, "open");
  assert.equal(store.customer?.connectedAccountId, "acct_1");

  await service.handleBrowserReturn({
    guildId: "guild-1",
    discordUserId: "discord-1",
    checkoutAttemptId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(reconciliations, [
    {
      connectedAccountId: "acct_1",
      correlationId: "11111111-1111-4111-8111-111111111111",
    },
  ]);
});

function supportService(store: MemorySupportStore): CommerceSupportService {
  return new CommerceSupportService(
    store,
    {
      async createCustomer() {
        return { id: "cus_1" };
      },
      async createSupportCheckout() {
        return { id: "cs_1", url: "https://checkout.stripe.test" };
      },
      async createRefund() {
        return { id: "re_1" };
      },
    },
    { async request() {} },
    TERMS,
    () => NOW,
  );
}

function config(): CommerceSupportConfig {
  return {
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    enabled: true,
    explanation: "Helps cover ordinary tools and services used to operate this community.",
    currency: "AUD",
    suggestedAmountsMinor: [500, 1_000, 2_000],
    supportContact: "seller@example.test",
    termsVersion: TERMS,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
}

function context(): CommerceSupportContext {
  return {
    account: {
      id: "acct_1",
      guildId: "guild-1",
      stripeAccountId: "acct_1",
      status: "active",
      country: "AU",
      defaultCurrency: "AUD",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      providerCreatedAtMs: NOW,
      archivedAtMs: null,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    seller: {
      connectedAccountId: "acct_1",
      guildId: "guild-1",
      sellerOwnerUserId: "seller-user-1",
      lifecycleState: "active",
      approvalState: "approved",
      supportContact: "seller@example.test",
      adultAttestedAtMs: NOW,
      twoFactorEvidence: "discord_verified",
      guildCreatedAtMs: NOW - 100_000,
      ownershipTransferredAtMs: null,
      guildGoodStanding: true,
      sellerGoodStanding: true,
      requirementsCurrentlyDueJson: "[]",
      requirementsEventuallyDueJson: "[]",
      requirementsPendingVerificationJson: "[]",
      disabledReason: null,
      reviewedByUserId: "operator-1",
      reviewedAtMs: NOW,
      capabilitiesUpdatedAtMs: NOW,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
    termsAccepted: true,
    premiumActive: true,
    suspended: false,
  };
}

class MemorySupportStore implements CommerceSupportStore {
  config: CommerceSupportConfig | null = null;
  readonly context = context();
  buyer: CommerceBuyer = {
    id: "buyer-1",
    discordUserId: "discord-1",
    createdAtMs: NOW,
    updatedAtMs: NOW,
  };
  customer: CommerceCustomer | null = null;
  attempt: CommerceSupportCheckoutAttempt | null = null;

  async readConfigByGuild() {
    return this.config;
  }
  async readContextByGuild() {
    return this.context;
  }
  async saveConfig(value: CommerceSupportConfig) {
    this.config = value;
  }
  async getOrCreateBuyer() {
    return this.buyer;
  }
  async readCustomer() {
    return this.customer;
  }
  async saveCustomer(value: CommerceCustomer) {
    this.customer = value;
  }
  async claimRateLimit() {
    return true;
  }
  async reserveCheckout(value: CommerceSupportCheckoutAttempt) {
    this.attempt = value;
    return true;
  }
  async attachCheckoutSession(_attemptId: string, sessionId: string, nowMs: number) {
    assert.ok(this.attempt);
    this.attempt = {
      ...this.attempt,
      stripeCheckoutSessionId: sessionId,
      status: "open",
      updatedAtMs: nowMs,
    };
  }
  async failCheckout() {}
  async markCheckoutReturned(input: {
    attemptId: string;
    guildId: string;
    buyerId: string;
    nowMs: number;
  }) {
    if (
      !this.attempt ||
      this.attempt.id !== input.attemptId ||
      this.attempt.guildId !== input.guildId ||
      this.attempt.buyerId !== input.buyerId
    )
      return null;
    this.attempt = {
      ...this.attempt,
      status: "returned",
      returnedAtMs: input.nowMs,
    };
    return this.attempt;
  }
  async readPaymentStatus() {
    return null;
  }
  async readPayment() {
    return null;
  }
  async readReport() {
    return [];
  }
}
