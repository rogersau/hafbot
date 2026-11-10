/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  CommerceSellerLifecycleService,
  deriveCommerceSellerLifecycle,
  evaluateCommerceSellerEligibility,
  type CommercePremiumReader,
  type CommerceSellerAccountProvider,
  type StripeConnectedAccountProjection,
} from "../src/commerce";
import { createCloudflareCommerceStore } from "../src/runtime/cloudflare-commerce-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_800_000_000_000;
const OLD_GUILD = NOW - 45 * 24 * 60 * 60 * 1_000;

test("seller eligibility separates connect checks from purchase capability gates", () => {
  const input = {
    action: "connect" as const,
    nowMs: NOW,
    premiumActive: true,
    ownerAuthorized: true,
    adultAttestedAtMs: NOW,
    twoFactorEvidence: "seller_attested" as const,
    guildCreatedAtMs: OLD_GUILD,
    ownershipTransferredAtMs: null,
    guildGoodStanding: true,
    sellerGoodStanding: true,
    supportContact: "seller@example.test",
    currentTermsAccepted: true,
    approvalState: "pending" as const,
    stripeDetailsSubmitted: false,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    globallySuspended: false,
    guildSuspended: false,
  };
  assert.deepEqual(evaluateCommerceSellerEligibility(input), {
    action: "connect",
    eligible: true,
    purchaseAvailable: false,
    reasons: [],
  });
  const publish = evaluateCommerceSellerEligibility({ ...input, action: "publish" });
  assert.equal(publish.eligible, false);
  assert.deepEqual(publish.reasons, [
    "hafbot_approval_required",
    "stripe_onboarding_incomplete",
    "stripe_charges_unavailable",
    "stripe_payouts_unavailable",
  ]);
  assert.equal(
    evaluateCommerceSellerEligibility({
      ...input,
      guildCreatedAtMs: NOW - 10 * 24 * 60 * 60 * 1_000,
    }).eligible,
    true,
  );
});

test("seller lifecycle prioritises suspension, onboarding, review, and provider repair", () => {
  const account = {
    status: "active" as const,
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  };
  assert.equal(
    deriveCommerceSellerLifecycle({
      account,
      approvalState: "approved",
      disabledReason: null,
      suspended: false,
    }),
    "active",
  );
  assert.equal(
    deriveCommerceSellerLifecycle({
      account: { ...account, payoutsEnabled: false },
      approvalState: "approved",
      disabledReason: null,
      suspended: false,
    }),
    "repair_required",
  );
  assert.equal(
    deriveCommerceSellerLifecycle({
      account,
      approvalState: "approved",
      disabledReason: null,
      suspended: true,
    }),
    "suspended",
  );
});

test("eligible Premium seller can onboard, accept versioned terms, and reach approval", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    const provider = new FakeSellerProvider();
    const premium = new MutablePremiumReader(true);
    let id = 0;
    const service = new CommerceSellerLifecycleService(
      store,
      premium,
      provider,
      () => NOW,
      () => `commerce-id-${++id}`,
    );
    const result = await service.beginOnboarding(onboardingInput());
    assert.equal(result.onboardingUrl, "https://connect.stripe.test/onboarding");
    assert.equal(result.account.stripeAccountId, "acct_seller");
    assert.equal(
      (await store.readSellerProfile(result.account.id))?.lifecycleState,
      "onboarding_incomplete",
    );
    assert.ok(await store.readSellerAcceptance(result.account.id, "seller-terms-v1"));
    assert.deepEqual(provider.createdWith, {
      guildId: "guild-1",
      sellerUserId: "seller-user-1",
      idempotencyKey: "commerce-connect:guild-1:seller-user-1",
    });
    const retry = await service.beginOnboarding({ ...onboardingInput(), attemptId: "attempt-2" });
    assert.equal(retry.account.id, result.account.id);
    assert.equal(provider.createAccountCalls, 1);
    assert.equal(provider.onboardingLinkCalls, 2);

    provider.projection = projection({
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    assert.equal((await service.refreshAccount("guild-1")).lifecycleState, "pending_review");
    assert.equal(
      (
        await service.reviewSeller({
          guildId: "guild-1",
          approvalState: "approved",
          actorUserId: "operator-1",
          reasonCode: "pilot_approved",
        })
      ).lifecycleState,
      "active",
    );
    assert.equal(
      (
        await service.evaluateAction({
          guildId: "guild-1",
          action: "purchase",
          ownerAuthorized: true,
          currentTermsVersion: "seller-terms-v1",
        })
      ).purchaseAvailable,
      true,
    );

    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commerce_operations_ledger",
      )[0]?.count,
      3,
    );
    const profileColumns = database.query<{ name: string }>(
      "PRAGMA table_info(commerce_seller_profiles)",
    );
    assert.equal(
      profileColumns.some(({ name }) => /bank|document|external_account|person/i.test(name)),
      false,
    );
  } finally {
    database.close();
  }
});

test("Premium, provider capability, and suspension failures block new purchases only", async () => {
  const database = await createTestDatabase();
  try {
    const store = createCloudflareCommerceStore(database.d1);
    const provider = new FakeSellerProvider();
    const premium = new MutablePremiumReader(true);
    const service = new CommerceSellerLifecycleService(
      store,
      premium,
      provider,
      () => NOW,
      () => crypto.randomUUID(),
    );
    await service.beginOnboarding(onboardingInput());
    provider.projection = projection({
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    await service.refreshAccount("guild-1");
    await service.reviewSeller({
      guildId: "guild-1",
      approvalState: "approved",
      actorUserId: "operator-1",
      reasonCode: "pilot_approved",
    });

    premium.active = false;
    assert.deepEqual(
      (
        await service.evaluateAction({
          guildId: "guild-1",
          action: "purchase",
          ownerAuthorized: true,
          currentTermsVersion: "seller-terms-v1",
        })
      ).reasons,
      ["premium_required"],
    );
    premium.active = true;

    provider.projection = projection({
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: false,
    });
    assert.equal((await service.refreshAccount("guild-1")).lifecycleState, "repair_required");
    const payoutUnavailable = await service.evaluateAction({
      guildId: "guild-1",
      action: "purchase",
      ownerAuthorized: true,
      currentTermsVersion: "seller-terms-v1",
    });
    assert.deepEqual(payoutUnavailable.reasons, ["stripe_payouts_unavailable"]);

    await service.setSuspension({
      scopeType: "guild",
      scopeId: "guild-1",
      suspended: true,
      reasonCode: "pilot_review",
      actorUserId: "operator-1",
    });
    const suspended = await service.evaluateAction({
      guildId: "guild-1",
      action: "purchase",
      ownerAuthorized: true,
      currentTermsVersion: "seller-terms-v1",
    });
    assert.deepEqual(suspended.reasons, ["commerce_guild_suspended", "stripe_payouts_unavailable"]);

    // Purchase availability changes do not mutate existing Commerce Entitlements.
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM commerce_entitlements")[0]
        ?.count,
      0,
    );
  } finally {
    database.close();
  }
});

class MutablePremiumReader implements CommercePremiumReader {
  constructor(public active: boolean) {}

  async isPremium(): Promise<boolean> {
    return this.active;
  }
}

class FakeSellerProvider implements CommerceSellerAccountProvider {
  projection = projection({
    detailsSubmitted: false,
    chargesEnabled: false,
    payoutsEnabled: false,
  });
  createdWith: unknown = null;
  createAccountCalls = 0;
  onboardingLinkCalls = 0;

  async createConnectedAccount(
    input: Parameters<CommerceSellerAccountProvider["createConnectedAccount"]>[0],
  ): Promise<StripeConnectedAccountProjection> {
    this.createdWith = input;
    this.createAccountCalls += 1;
    return this.projection;
  }

  async createOnboardingLink(): Promise<{ url: string }> {
    this.onboardingLinkCalls += 1;
    return { url: "https://connect.stripe.test/onboarding" };
  }

  async createAccountManagementLink(): Promise<{ url: string }> {
    return { url: "https://connect.stripe.test/dashboard" };
  }

  async readConnectedAccount(): Promise<StripeConnectedAccountProjection> {
    return this.projection;
  }
}

function projection(
  overrides: Partial<StripeConnectedAccountProjection>,
): StripeConnectedAccountProjection {
  return {
    id: "acct_seller",
    country: "AU",
    defaultCurrency: "aud",
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    disabledReason: null,
    currentlyDue: [],
    eventuallyDue: [],
    pendingVerification: [],
    providerCreatedAtMs: NOW - 1_000,
    ...overrides,
  };
}

function onboardingInput() {
  return {
    guildId: "guild-1",
    sellerUserId: "seller-user-1",
    ownerAuthorized: true,
    supportContact: "seller@example.test",
    adultAttestedAtMs: NOW,
    twoFactorEvidence: "seller_attested" as const,
    guildCreatedAtMs: OLD_GUILD,
    ownershipTransferredAtMs: null,
    guildGoodStanding: true,
    sellerGoodStanding: true,
    termsVersion: "seller-terms-v1",
    termsAccepted: true,
    refreshUrl: "https://haf.test/refresh",
    returnUrl: "https://haf.test/return",
    attemptId: "attempt-1",
  };
}
