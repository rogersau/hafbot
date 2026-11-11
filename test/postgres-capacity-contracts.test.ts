import assert from "node:assert/strict";
import test from "node:test";
import { PostgresBillingAssignmentStore } from "../src/runtime/postgres/postgres-billing-assignment-store";
import { PostgresCommerceSafeguardStore } from "../src/runtime/postgres/postgres-commerce-safeguard-store";
import { COMMERCE_PILOT_LIMITS, CommerceSafeguardsService } from "../src/commerce/safeguards";
import { withFreshPostgres } from "./support/postgres";

const postgresOnly = {
  skip: process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured",
};

test(
  "native Billing serializes assignment capacity and keeps effective plans atomic",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      await database.execute(`INSERT INTO billing_customer_bindings(owner_id,stripe_customer_id,created_at_ms) VALUES ('owner','customer',1),('other','other-customer',1);
      INSERT INTO billing_subscriptions(owner_id,stripe_customer_id,stripe_subscription_id,plan,status,observed_at_ms) VALUES ('owner','customer','subscription','premium','active',1),('other','other-customer','other-subscription','premium_plus','active',1)`);
      const store = new PostgresBillingAssignmentStore(database);
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          store.assign({
            ownerId: "owner",
            subscriptionId: "subscription",
            guildId: `guild-${index}`,
            plan: "premium",
            capacity: 1,
            nowMs: 1,
          }),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const guildId = `guild-${claims.findIndex(Boolean)}`;
      assert.equal(
        await store.assign({
          ownerId: "other",
          subscriptionId: "other-subscription",
          guildId,
          plan: "premium_plus",
          capacity: 3,
          nowMs: 2,
        }),
        false,
      );
      assert.equal((await store.readEffectivePlans([guildId])).get(guildId), "premium");
      assert.equal(
        await store.move({
          ownerId: "owner",
          subscriptionId: "subscription",
          fromGuildId: guildId,
          toGuildId: "destination",
          plan: "premium",
          nowMs: 3,
        }),
        true,
      );
      assert.deepEqual(
        await store.readEffectivePlans([guildId, "destination"]),
        new Map([
          [guildId, "free"],
          ["destination", "premium"],
        ]),
      );
      await assert.rejects(
        store.assign({
          ownerId: "owner",
          subscriptionId: "subscription",
          guildId: "rollback",
          plan: "invalid" as never,
          capacity: 2,
          nowMs: 4,
        }),
      );
      assert.equal((await store.listAssignments("owner")).length, 1);
      assert.equal((await store.readEffectivePlans(["rollback"])).size, 0);
      assert.equal(
        await store.unassign({
          ownerId: "owner",
          subscriptionId: "subscription",
          guildId: "destination",
          nowMs: 5,
        }),
        true,
      );
      assert.equal((await store.readEffectivePlans(["destination"])).get("destination"), "free");
    });
  },
);

test(
  "native Commerce fences concurrent capacity claims and applies current checkout controls",
  postgresOnly,
  async () => {
    await withFreshPostgres(async (database) => {
      const now = Date.UTC(2030, 5, 15);
      await database.execute(`INSERT INTO commerce_subscriptions(id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,created_at_ms,updated_at_ms)
      SELECT 'subscription-'||n,'account','customer','buyer-'||n,'offering','price','provider-'||n,'active',1,1 FROM generate_series(1,${COMMERCE_PILOT_LIMITS.activeSubscribers - 1}) AS n`);
      const store = new PostgresCommerceSafeguardStore(database);
      const claim = (id: string) => ({
        id,
        checkoutKind: "subscription" as const,
        connectedAccountId: "account",
        guildId: "guild",
        offeringId: "offering",
        currency: "AUD" as const,
        amountMinor: 100,
        expiresAtMs: now + 60_000,
        nowMs: now,
      });
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, index) => store.claimCapacity(claim(`claim-${index}`))),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const winner = `claim-${claims.findIndex(Boolean)}`;
      assert.equal(await store.claimCapacity(claim(winner)), true);
      assert.equal(await store.claimCapacity({ ...claim(winner), amountMinor: 200 }), false);
      await store.releaseCapacity(winner);
      assert.equal(await store.claimCapacity(claim("replacement")), true);
      await store.releaseCapacity("replacement");
      assert.equal(
        await store.claimCapacity({
          ...claim("support-small"),
          checkoutKind: "support",
          offeringId: null,
          amountMinor: 9_000,
        }),
        true,
      );
      await store.releaseCapacity("support-small");
      assert.equal(
        await store.claimCapacity({
          ...claim("support-over-limit"),
          checkoutKind: "support",
          offeringId: null,
          amountMinor: COMMERCE_PILOT_LIMITS.supportPaymentMinor + 1,
        }),
        false,
      );
      await new CommerceSafeguardsService(
        store,
        () => now,
        () => "control",
      ).setControl({
        scopeType: "guild",
        scopeId: "guild",
        controlType: "new_checkout",
        enabled: true,
        reasonCode: "operator_pause",
        actorUserId: "operator",
      });
      assert.equal(await store.claimCapacity(claim("blocked")), false);
    });
  },
);
