import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresGameAccessStore } from "../src/runtime/postgres/postgres-game-access-store";
import { createPostgresJobQueue } from "../src/runtime/postgres/postgres-job-queue";
import { createPostgresD1CompatibilityDatabase } from "../src/runtime/postgres/postgres-d1-compat";
import { CloudflareCommerceBuyerCheckoutStore } from "../src/runtime/commerce/cloudflare-buyer-checkout-store";
import { createGameAccessRuntime } from "../src/runtime/commerce/game-access-runtime";
import { createCloudflarePlatformLinkStore } from "../src/runtime/cloudflare-platform-link-store";
import { createCloudflareWardogsStore } from "../src/runtime/cloudflare-wardogs-store";
import { WardogsService } from "../src/wardogs/service";
import type { Assignment } from "../src/commerce/game-access/model";
const url = process.env.TEST_POSTGRES_URL;
test(
  "native PostgreSQL buyer status selects the current subscription before terminal history",
  { skip: !url },
  async () => {
    assert.ok(url);
    assert.match(new URL(url).pathname, /_test$/);
    const db = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: url,
      NODE_ENV: "test",
    });
    try {
      await applyPostgresMigrations(
        db,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const d1 = createPostgresD1CompatibilityDatabase(db);
      const store = new CloudflareCommerceBuyerCheckoutStore(d1, { isPremium: async () => true });
      const scope = crypto.randomUUID();
      const input = {
        connectedAccountId: scope,
        buyerId: "buyer",
        offeringId: scope,
        nowMs: 10_000,
      };
      assert.equal((await store.readBuyerStatus(input)).checkoutAttemptId, null);
      await d1
        .prepare(`INSERT INTO commerce_offerings
      (id,connected_account_id,guild_id,discord_role_id,name,purchase_type,status,created_at_ms,updated_at_ms)
      VALUES(?,?,'guild','role','Fixture','subscription','draft',1,1)`)
        .bind(scope, scope)
        .run();
      for (const [suffix, createdAtMs] of [
        ["old", 1],
        ["current", 2],
      ] as const) {
        const id = `${scope}-${suffix}`;
        await store.reserveCheckout({
          id,
          connectedAccountId: scope,
          buyerId: "buyer",
          guildId: "guild",
          offeringId: scope,
          priceId: "price",
          stripeCheckoutSessionId: null,
          status: "expired",
          expiresAtMs: 100,
          returnedAtMs: null,
          createdAtMs,
          updatedAtMs: 100,
        });
        // Both subscriptions were first observed in one snapshot; checkout chronology
        // still identifies the latest purchase when both later become terminal.
        await d1
          .prepare(`INSERT INTO commerce_subscriptions
        (id,checkout_attempt_id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,created_at_ms,updated_at_ms,current_period_end_ms)
        VALUES(?,?,?,'customer','buyer',?,'price',?,'canceled',100,100,?)`)
          .bind(id, id, scope, scope, `sub_${id}`, createdAtMs * 1000)
          .run();
      }
      const currentId = `${scope}-current`;
      assert.equal((await store.readBuyerStatus(input)).checkoutAttemptId, currentId);
      // All non-terminal states are current, even those that do not grant access.
      for (const status of ["active", "incomplete", "trialing", "past_due", "paused", "unpaid"]) {
        await d1
          .prepare("UPDATE commerce_subscriptions SET status=? WHERE id=?")
          .bind(status, currentId)
          .run();
        // A more recently refreshed historical row must not displace current truth.
        await d1
          .prepare("UPDATE commerce_subscriptions SET updated_at_ms=200 WHERE id=?")
          .bind(`${scope}-old`)
          .run();
        const result = await store.readBuyerStatus(input);
        assert.equal(result.subscriptionStatus, status);
        assert.equal(result.checkoutAttemptId, currentId);
        assert.equal(result.currentPeriodEndMs, 2000);
      }
      for (const status of ["canceled", "ended"]) {
        await d1
          .prepare("UPDATE commerce_subscriptions SET status=? WHERE id=?")
          .bind(status, currentId)
          .run();
        assert.equal((await store.readBuyerStatus(input)).checkoutAttemptId, currentId);
      }
      const pendingId = `${scope}-pending`;
      await store.reserveCheckout({
        id: pendingId,
        connectedAccountId: scope,
        buyerId: "buyer",
        guildId: "guild",
        offeringId: scope,
        priceId: "price",
        stripeCheckoutSessionId: null,
        status: "creating",
        expiresAtMs: 20_000,
        returnedAtMs: null,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      });
      assert.equal((await store.readBuyerStatus(input)).checkoutAttemptId, pendingId);
      assert.equal(
        (await store.readBuyerStatus({ ...input, nowMs: 20_001 })).checkoutAttemptId,
        currentId,
      );
      for (const otherScope of [
        { connectedAccountId: `${scope}-other` },
        { buyerId: "other-buyer" },
        { offeringId: `${scope}-other` },
      ]) {
        const result = await store.readBuyerStatus({ ...input, ...otherScope });
        assert.equal(result.checkoutAttemptId, null);
        assert.equal(result.subscriptionStatus, null);
      }
    } finally {
      await db.close();
    }
  },
);
test(
  "native PostgreSQL reserved-access allocation, cross-Guild ownership and desired-state CAS",
  { skip: !url },
  async () => {
    assert.ok(url);
    assert.match(new URL(url).pathname, /_test$/);
    const db = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: url,
      NODE_ENV: "test",
    });
    try {
      await applyPostgresMigrations(
        db,
        await readPostgresMigrations(resolve("migrations/postgres")),
      );
      const store = createPostgresGameAccessStore(db);
      const physical = crypto.randomUUID();
      const base: Assignment = {
        platform: "steam",
        id: crypto.randomUUID(),
        guildId: "guild",
        userId: "buyer",
        targetId: "target",
        physicalTarget: physical,
        origin: "https://synthetic.example",
        subject: "76561198000000001",
        ownership: "none",
        generation: 1,
        revision: 1,
        desired: false,
        state: "pending",
        reason: "awaiting_payment",
        entitlementIds: [],
        attempts: 0,
        nextAtMs: 0,
        updatedAtMs: 0,
        transmitted: null,
        observed: null,
        obligation: false,
        slot: null,
      };
      const allocation = await Promise.allSettled([
        store.reserve(base, 1),
        store.reserve(
          { ...base, id: crypto.randomUUID(), subject: "76561198000000002", userId: "other" },
          1,
        ),
      ]);
      assert.equal(allocation.filter((r) => r.status === "fulfilled").length, 1);
      const winner = allocation.find((r) => r.status === "fulfilled");
      assert.ok(winner && winner.status === "fulfilled");
      await assert.rejects(
        store.reserve(
          { ...winner.value, id: crypto.randomUUID(), guildId: "other-guild", targetId: "alias" },
          1,
        ),
        /conflicting owner/,
      );
      const deferred = await Promise.all([
        store.deferPublication(winner.value, 60_000),
        store.deferPublication(winner.value, 60_000),
      ]);
      assert.equal(deferred.filter(Boolean).length, 1);
      assert.equal(deferred.find(Boolean)!.revision, winner.value.revision);
      assert.equal((await store.read(winner.value.id))?.nextAtMs, 60_000);
      const claims = await Promise.all([
        store.save({ ...winner.value, desired: true, generation: 2 }, 1),
        store.save({ ...winner.value, desired: true, generation: 2 }, 1),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const saved = claims.find(Boolean)!;
      assert.equal(await store.deferPublication(deferred.find(Boolean)!, 120_000), null);
      const jobs = createPostgresJobQueue(db);
      await jobs.enqueue({
        queueName: "commerce-game-access",
        payload: {
          assignments: [
            { assignmentId: saved.id, generation: saved.generation, revision: saved.revision },
          ],
        },
        dedupeKey: physical,
      });
      const work = await jobs.claim({
        ownerId: "fixture",
        queueNames: ["commerce-game-access"],
        limit: 1,
      });
      assert.equal(work.length, 1);
      assert.deepEqual(work[0].payload, {
        assignments: [
          { assignmentId: saved.id, generation: saved.generation, revision: saved.revision },
        ],
      });
      assert.equal(await store.save({ ...saved, desired: false }, 1), null);
      await store.configure({
        offeringId: physical,
        guildId: "guild",
        targetId: "target",
        physicalTarget: physical,
        origin: base.origin,
        capability: "reserved-slot",
        allocationCeiling: 1,
        acceptingSales: false,
        updatedAtMs: 1,
      });
      assert.equal((await store.config(physical))?.physicalTarget, physical);
      await store.select({
        platform: "steam",
        checkoutId: physical,
        offeringId: physical,
        guildId: "guild",
        buyerId: "buyer",
        userId: saved.userId,
        subject: saved.subject,
        assignmentId: saved.id,
        createdAtMs: 1,
      });
      await assert.rejects(
        store.select({
          platform: "steam",
          checkoutId: physical,
          offeringId: physical,
          guildId: "other",
          buyerId: "buyer",
          userId: saved.userId,
          subject: saved.subject,
          assignmentId: saved.id,
          createdAtMs: 1,
        }),
        /substituted/,
      );
      // Exercise the actual portable checkout failure/truth readers, without the
      // unrelated pre-existing financial readSyncState camel-case alias limitation.
      const d1 = createPostgresD1CompatibilityDatabase(db);
      const buyerStore = new CloudflareCommerceBuyerCheckoutStore(d1, {
        isPremium: async () => true,
      });
      let now = 1_900_000_000_000;
      const runtime = createGameAccessRuntime({
        database: d1,
        store,
        wardogs: new WardogsService({
          store: createCloudflareWardogsStore(d1),
          runtime: "portable",
        }),
        platformLink: createCloudflarePlatformLinkStore(d1),
        botUserId: "fixture",
        botToken: "synthetic-only",
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
        provider: {
          readiness: async (guildId, targetId) => ({
            guildId,
            targetId,
            generation: 1,
            physicalTarget: physical,
            origin: base.origin,
            capacity: 1,
            ready: true,
          }),
          capabilities: async () => true,
          list: async () => new Set(),
          mutate: async () => {
            assert.fail("Unpaid allocations must not mutate the provider");
          },
        },
      });
      for (const outcome of ["confirmed_not_sent", "unknown"] as const) {
        const checkoutId = `${physical}-${outcome}`;
        assert.equal(
          await buyerStore.reserveCheckout({
            id: checkoutId,
            connectedAccountId: physical,
            buyerId: "buyer",
            guildId: "guild",
            offeringId: physical,
            priceId: "price",
            stripeCheckoutSessionId: null,
            status: "creating",
            expiresAtMs: now + 100_000,
            returnedAtMs: null,
            createdAtMs: now,
            updatedAtMs: now,
          }),
          true,
        );
        await store.select({
          platform: "steam",
          checkoutId,
          offeringId: physical,
          guildId: "guild",
          buyerId: "buyer",
          userId: saved.userId,
          subject: saved.subject,
          assignmentId: saved.id,
          createdAtMs: now,
        });
        await buyerStore.failCheckout(checkoutId, now, outcome);
        const row = await d1
          .prepare(
            "SELECT pre_session_failed_at_ms,provider_terminal_at_ms FROM commerce_checkout_attempts WHERE id=?",
          )
          .bind(checkoutId)
          .first<{
            pre_session_failed_at_ms: number | null;
            provider_terminal_at_ms: number | null;
          }>();
        assert.equal(row?.pre_session_failed_at_ms, outcome === "confirmed_not_sent" ? now : null);
        assert.equal(row?.provider_terminal_at_ms, null);
      }
      // Remove only this test's deliberately orphaned initial selection so all real
      // selections now correspond to checkout attempts with distinct failure evidence.
      await d1
        .prepare("DELETE FROM commerce_game_selections WHERE checkout_id=?")
        .bind(physical)
        .run();
      await runtime.service.processDue();
      assert.notEqual(
        (await store.read(saved.id))?.slot,
        null,
        "an ambiguous checkout retains aggregated capacity",
      );
      await d1
        .prepare("DELETE FROM commerce_game_selections WHERE checkout_id=?")
        .bind(`${physical}-unknown`)
        .run();
      now += 900001;
      await runtime.service.processDue();
      assert.equal(
        (await store.read(saved.id))?.slot,
        null,
        "confirmed pre-session failure releases capacity",
      );
      assert.equal((await store.read(saved.id))?.state, "removed");
      const replacementId = `${physical}-pending`;
      await buyerStore.reserveCheckout({
        id: replacementId,
        connectedAccountId: physical,
        buyerId: "buyer",
        guildId: "guild",
        offeringId: physical,
        priceId: "price",
        stripeCheckoutSessionId: null,
        status: "creating",
        expiresAtMs: now + 100_000,
        returnedAtMs: null,
        createdAtMs: now,
        updatedAtMs: now,
      });
      const status = await buyerStore.readBuyerStatus({
        connectedAccountId: physical,
        buyerId: "buyer",
        offeringId: physical,
        nowMs: now,
      });
      assert.equal(status.checkoutAttemptId, replacementId);
      assert.equal(status.subscriptionStatus, null);
      await d1
        .prepare(`INSERT INTO commerce_subscriptions
        (id,checkout_attempt_id,connected_account_id,customer_id,buyer_id,offering_id,price_id,stripe_subscription_id,status,created_at_ms,updated_at_ms)
        VALUES(?,?,?,'customer','buyer',?,'price',?,'active',?,?)`)
        .bind(physical, replacementId, physical, physical, `sub_${physical}`, now, now)
        .run();
      const paidStatus = await buyerStore.readBuyerStatus({
        connectedAccountId: physical,
        buyerId: "buyer",
        offeringId: physical,
        nowMs: now,
      });
      assert.equal(paidStatus.subscriptionStatus, "active");
      assert.equal(paidStatus.checkoutAttemptId, replacementId);
      assert.equal(
        (
          await buyerStore.readBuyerStatus({
            connectedAccountId: "other",
            buyerId: "buyer",
            offeringId: physical,
            nowMs: now,
          })
        ).checkoutAttemptId,
        null,
      );
    } finally {
      await db.close();
    }
  },
);
