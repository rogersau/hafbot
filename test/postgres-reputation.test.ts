import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPostgresMigrations,
  readPostgresMigrations,
} from "../src/runtime/postgres/postgres-migrations";
import { createPostgresDatabaseCapabilityFromEnvironment } from "../src/runtime/postgres/postgres-capability";
import { createPostgresReputationStore } from "../src/reputation/store";
import { defaultReputationConfig, type ReputationAwardInput } from "../src/reputation/types";

const postgresUrl = process.env.TEST_POSTGRES_URL;
test(
  "PostgreSQL reputation atomically deduplicates awards, enforces cooldowns, isolates Guilds and anonymizes erased receipts",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    const url = new URL(postgresUrl);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.endsWith("_test"),
      "Use a disposable local database ending in _test.",
    );
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "4",
    });
    try {
      await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await applyPostgresMigrations(database, await readPostgresMigrations("migrations/postgres"));
      const store = createPostgresReputationStore(database);
      assert.equal((await store.getConfig("100")).enabled, false);
      const settings = {
        ...defaultReputationConfig("100"),
        enabled: true,
        cooldownSeconds: 60,
        rewards: [{ threshold: 1, roleId: "301" }],
      };
      await store.saveConfig("100", settings, 0);
      await store.saveConfig("110", settings, 0);
      await assert.rejects(() => store.saveConfig("100", settings, 0), /changed/);
      const input: ReputationAwardInput = {
        guildId: "100",
        interactionId: "200",
        giver: { userId: "101", displayName: "Giver", bot: false, roleIds: [] },
        recipient: { userId: "102", displayName: "Recipient", bot: false, roleIds: [] },
        reason: "Helpful guide",
        nowMs: 1_000,
      };
      const repeated = await Promise.all([store.award(input), store.award(input)]);
      assert.equal(repeated.filter((award) => !award.duplicate).length, 1);
      assert.equal(await store.score("100", "102"), 1);
      assert.equal((await store.pendingRewards(1_000, 20)).length, 1);
      await assert.rejects(() => store.award({ ...input, interactionId: "201" }), /cooldown/);
      assert.equal(
        (await database.query<{ count: string }>("SELECT COUNT(*) FROM reputation_awards"))[0]!
          .count,
        "1",
      );
      const concurrent = await Promise.allSettled([
        store.award({ ...input, interactionId: "202", nowMs: 61_000 }),
        store.award({ ...input, interactionId: "203", nowMs: 61_000 }),
      ]);
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(await store.score("100", "102"), 2);
      await store.award({ ...input, guildId: "110", interactionId: "200" });
      assert.equal(await store.score("110", "102"), 1);
      await store.setMembership("100", "102", false);
      assert.deepEqual(await store.topScores("100", 10), []);
      await store.setMembership("100", "102", true);
      assert.equal((await store.topScores("100", 10))[0]?.total, 2);
      const jobs = await store.pendingRewards(1_000, 20, "100");
      await store.completeReward(jobs[0]!, 2_000);
      assert.deepEqual(await store.pendingRewards(3_000, 20, "100"), []);
      await store.saveConfig("100", { ...settings, rewards: [{ threshold: 2, roleId: "302" }] }, 1);
      assert.deepEqual(
        (await store.pendingRewards(3_000, 20, "100")).map((job) => job.roleId),
        ["302"],
      );
      await store.eraseMember("100", "101");
      const receipt = (
        await database.query<{
          giver_id: string | null;
          recipient_id: string | null;
          reason: string | null;
        }>(
          "SELECT giver_id,recipient_id,reason FROM reputation_awards WHERE guild_id = '100' AND interaction_id = '200'",
        )
      )[0]!;
      assert.deepEqual(receipt, { giver_id: null, recipient_id: null, reason: null });
      await assert.rejects(
        () => store.award({ ...input, nowMs: 1_000_000 }),
        /already been used or erased/,
      );
      assert.equal(await store.score("100", "102"), 2);
      await store.eraseMember("100", "102");
      assert.equal(await store.score("100", "102"), 0);
      assert.deepEqual(await store.pendingRewards(10_000, 20, "100"), []);
      assert.equal(await store.score("110", "102"), 1);
    } finally {
      await database.close();
    }
  },
);
