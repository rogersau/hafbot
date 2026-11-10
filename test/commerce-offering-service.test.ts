/// <reference types="node/assert" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  CommerceOfferingService,
  type CommerceOfferingProvider,
  type CommerceOfferingStore,
} from "../src/commerce/offering-service";
import { CloudflareCommerceOfferingStore } from "../src/runtime/commerce/cloudflare-offering-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

const NOW = 1_900_000_000_000;

test("approved seller can create and publish a subscription offering", async () => {
  const database = await createTestDatabase();
  try {
    database.execRaw(`
      INSERT INTO guild_entitlements(guild_id,tier,plan,updated_at_ms) VALUES ('guild-1','premium','premium',${NOW});
      INSERT INTO commerce_connected_accounts(id,guild_id,stripe_account_id,status,country,default_currency,charges_enabled,payouts_enabled,details_submitted,created_at_ms,updated_at_ms)
        VALUES ('acct_1','guild-1','acct_1','active','AU','AUD',1,1,1,${NOW},${NOW});
      INSERT INTO commerce_seller_profiles(connected_account_id,guild_id,lifecycle_state,approval_state,support_contact,adult_attested_at_ms,two_factor_evidence,guild_created_at_ms,guild_good_standing,seller_good_standing,reviewed_by_user_id,reviewed_at_ms,created_at_ms,updated_at_ms)
        VALUES ('acct_1','guild-1','active','approved','seller@example.test',${NOW},'seller_attested',${NOW}-1000000,1,1,'operator',${NOW},${NOW},${NOW});
      INSERT INTO commerce_seller_acceptances(id,connected_account_id,terms_version,accepted_by_user_id,accepted_at_ms,created_at_ms)
        VALUES ('accept-1','acct_1','v1','seller',${NOW},${NOW});
    `);
    const store = new CloudflareCommerceOfferingStore(database.d1, {
      async isPremium() {
        return true;
      },
    });
    const service = new CommerceOfferingService(store, new FakeProvider(), () => NOW, ids());
    const created = await service.createDraft({
      connectedAccountId: "acct_1",
      guildId: "guild-1",
      discordRoleId: "role-1",
      name: "Gold",
      description: "Benefits",
      includedBenefits: ["Private role"],
      supportContact: "seller@example.test",
      currency: "AUD",
      unitAmountMinor: 500,
      recurringInterval: "month",
      roleManageable: true,
      termsVersion: "v1",
    });
    assert.equal(created.lifecycle.state, "draft");
    assert.equal((await service.publish(created.offering.id)).state, "published");
    assert.equal((await store.readLifecycle(created.offering.id))?.state, "published");
    assert.equal((await store.listPrices(created.offering.id)).length, 1);
  } finally {
    database.close();
  }
});

test("publishing enforces five offerings, role and minimum price; price changes grandfather", async () => {
  const store = new FakeStore();
  const provider = new FakeProvider();
  const refreshes: string[] = [];
  const service = new CommerceOfferingService(
    store,
    provider,
    () => NOW,
    ids(),
    async (guildId) => {
      refreshes.push(guildId);
    },
  );
  await assert.rejects(
    () =>
      service.createDraft({
        connectedAccountId: "acct_1",
        guildId: "guild-1",
        discordRoleId: "r",
        name: "x",
        currency: "USD",
        includedBenefits: ["Access"],
        supportContact: "seller@example.test",
        unitAmountMinor: 499,
        recurringInterval: "month",
        roleManageable: true,
      }),
    /below_minimum/,
  );
  const created = await service.createDraft({
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    discordRoleId: "r",
    name: "x",
    currency: "USD",
    includedBenefits: ["Access"],
    supportContact: "seller@example.test",
    unitAmountMinor: 500,
    recurringInterval: "month",
    roleManageable: true,
  });
  store.context = {
    premiumActive: true,
    sellerEligible: true,
    termsAccepted: true,
    roleManageable: true,
  };
  await service.publish(created.offering.id);
  assert.deepEqual(refreshes, ["guild-1"]);
  await store.saveLifecycle({
    ...(await store.readLifecycle(created.offering.id)),
    state: "repair_required",
  });
  await assert.rejects(() => service.publish(created.offering.id), /publish_invalid_state/);
  await store.saveLifecycle({
    ...(await store.readLifecycle(created.offering.id)),
    state: "published",
  });
  const changed = await service.replacePrice({
    offeringId: created.offering.id,
    currency: "USD",
    unitAmountMinor: 900,
    recurringInterval: "year",
  });
  assert.equal(changed.unitAmountMinor, 900);
  assert.deepEqual(refreshes, ["guild-1", "guild-1"]);
  assert.deepEqual(
    (await store.listPrices(created.offering.id)).map((price) => price.status),
    ["retired", "active"],
  );
  assert.equal(provider.retired.length, 1);
  const duplicateRole = await service.createDraft({
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    discordRoleId: "r",
    name: "duplicate",
    currency: "USD",
    includedBenefits: ["Access"],
    supportContact: "https://example.test/support",
    unitAmountMinor: 500,
    recurringInterval: "month",
    roleManageable: true,
  });
  await assert.rejects(() => service.publish(duplicateRole.offering.id), /role_already_published/);
  await service.unpublish(created.offering.id);
  assert.deepEqual(refreshes, ["guild-1", "guild-1", "guild-1"]);
  assert.equal((await service.publish(duplicateRole.offering.id)).state, "published");
  await service.unpublish(duplicateRole.offering.id);
  await service.retire({
    offeringId: created.offering.id,
    actorUserId: "seller-1",
    reasonCode: "seller_requested",
    actionId: "retire-1",
    retireAtMs: NOW + 1_000,
  });
  assert.equal((await service.archive(created.offering.id)).state, "archived");
});

test("retirement initiation is idempotent and archive stays guarded by active subscriptions", async () => {
  const store = new FakeStore();
  const service = new CommerceOfferingService(store, new FakeProvider(), () => NOW, ids());
  const created = await service.createDraft({
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    discordRoleId: "r",
    name: "x",
    currency: "USD",
    includedBenefits: ["Access"],
    supportContact: "seller@example.test",
    unitAmountMinor: 500,
    recurringInterval: "month",
    roleManageable: true,
  });
  store.context = {
    premiumActive: true,
    sellerEligible: true,
    termsAccepted: true,
    roleManageable: true,
  };
  await service.publish(created.offering.id);
  const first = await service.retire({
    offeringId: created.offering.id,
    actorUserId: "seller-1",
    reasonCode: "seller_requested",
    actionId: "retire-1",
  });
  const second = await service.retire({
    offeringId: created.offering.id,
    actorUserId: "seller-2",
    reasonCode: "other_reason",
    actionId: "retire-2",
  });
  assert.deepEqual(second, first);
  assert.equal(store.retirementStarts, 1);

  const guarded = new FakeStore();
  guarded.activeSubscriptions = 1;
  const guardedService = new CommerceOfferingService(guarded, new FakeProvider(), () => NOW, ids());
  const guardedOffering = await guardedService.createDraft({
    connectedAccountId: "acct_1",
    guildId: "guild-1",
    discordRoleId: "r-guarded",
    name: "guarded",
    currency: "USD",
    includedBenefits: ["Access"],
    supportContact: "seller@example.test",
    unitAmountMinor: 500,
    recurringInterval: "month",
    roleManageable: true,
  });
  guarded.context = {
    premiumActive: true,
    sellerEligible: true,
    termsAccepted: true,
    roleManageable: true,
  };
  await guardedService.publish(guardedOffering.offering.id);
  await guardedService.retire({
    offeringId: guardedOffering.offering.id,
    actorUserId: "seller-1",
    reasonCode: "seller_requested",
    actionId: "retire-guarded",
  });
  await assert.rejects(
    () => guardedService.archive(guardedOffering.offering.id),
    /commerce_offering_active_subscriptions/,
  );
});

class FakeProvider implements CommerceOfferingProvider {
  private n = 0;
  readonly retired: string[] = [];
  async createProduct() {
    return { id: `prod_${++this.n}`, createdAtMs: NOW };
  }
  async createPrice() {
    return { id: `price_${++this.n}`, createdAtMs: NOW };
  }
  async retirePrice(input: { priceId: string }) {
    this.retired.push(input.priceId);
  }
}

class FakeStore implements CommerceOfferingStore {
  offerings = new Map<string, any>();
  lifecycles = new Map<string, any>();
  prices = new Map<string, any[]>();
  context = {
    premiumActive: false,
    sellerEligible: false,
    termsAccepted: false,
    roleManageable: false,
  };
  activeSubscriptions = 0;
  retirementStarts = 0;
  async createOffering(value: any) {
    this.offerings.set(value.id, value);
  }
  async readOffering(id: string) {
    return this.offerings.get(id) ?? null;
  }
  async listOfferings(id: string) {
    return [...this.offerings.values()].filter((x) => x.connectedAccountId === id);
  }
  async saveLifecycle(value: any) {
    this.lifecycles.set(value.offeringId, value);
  }
  async readLifecycle(id: string) {
    return this.lifecycles.get(id) ?? null;
  }
  async listLifecycles(id: string) {
    return [...this.lifecycles.values()].filter((x) => x.connectedAccountId === id);
  }
  async createPrice(value: any) {
    const list = this.prices.get(value.offeringId) ?? [];
    list.push(value);
    this.prices.set(value.offeringId, list);
    return true;
  }
  async listPrices(id: string) {
    return this.prices.get(id) ?? [];
  }
  async readPublishContext() {
    return this.context;
  }
  async countPublishedSubscriptions() {
    return 0;
  }
  async hasPublishedRoleMapping(guildId: string, roleId: string, excludingId: string) {
    return [...this.offerings.values()].some(
      (offering) =>
        offering.guildId === guildId &&
        offering.discordRoleId === roleId &&
        offering.id !== excludingId &&
        this.lifecycles.get(offering.id)?.state === "published",
    );
  }
  async beginRoleReplacement(input: {
    offering: any;
    lifecycle: any;
    replacementRoleId: string;
    nowMs: number;
  }) {
    this.offerings.set(input.offering.id, {
      ...input.offering,
      discordRoleId: input.replacementRoleId,
      updatedAtMs: input.nowMs,
    });
    this.lifecycles.set(input.offering.id, {
      ...input.lifecycle,
      roleManageable: true,
      updatedAtMs: input.nowMs,
    });
    return "updated" as const;
  }
  async beginRetirement(input: {
    offering: any;
    lifecycle: any;
    actorUserId: string;
    reasonCode: string;
    actionId: string;
    retireAtMs: number;
    nowMs: number;
  }) {
    this.retirementStarts += 1;
    this.offerings.set(input.offering.id, {
      ...input.offering,
      status: "draft",
      updatedAtMs: input.nowMs,
    });
    this.lifecycles.set(input.offering.id, {
      ...input.lifecycle,
      state: "retiring",
      retireAtMs: input.retireAtMs,
      updatedAtMs: input.nowMs,
    });
    (this as any).retirement = {
      status: this.activeSubscriptions === 0 ? "complete" : "waiting_for_period_end",
      activeSubscriptionCount: this.activeSubscriptions,
      scheduledCancellationCount: 0,
      failedCancellationCount: 0,
      latestPeriodEndMs: null,
      completedAtMs: this.activeSubscriptions === 0 ? input.nowMs : null,
    };
  }
  async archiveOffering(id: string, nowMs: number) {
    const retirement = (this as any).retirement;
    if (
      this.activeSubscriptions > 0 ||
      retirement?.status !== "complete" ||
      retirement.activeSubscriptionCount !== 0
    ) {
      return false;
    }
    const offering = this.offerings.get(id);
    const lifecycle = this.lifecycles.get(id);
    if (
      !offering ||
      !lifecycle ||
      (lifecycle.state !== "retiring" && lifecycle.state !== "draft")
    ) {
      return false;
    }
    this.offerings.set(id, {
      ...offering,
      status: "archived",
      archivedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    this.lifecycles.set(id, {
      ...lifecycle,
      state: "archived",
      archivedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    return true;
  }
  async readDashboard() {
    return { seller: null, offerings: [], estimatedProceedsAreNonAuthoritative: true as const };
  }
  async retirePrice(id: string, at: number) {
    const price = [...this.prices.values()].flat().find((x) => x.id === id);
    if (price) {
      price.status = "retired";
      price.retiredAtMs = at;
    }
  }
}

function ids(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}
