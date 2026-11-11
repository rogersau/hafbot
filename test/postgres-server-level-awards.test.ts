import assert from "node:assert/strict";
import test from "node:test";
import type { ServerLevelAward } from "../src/server-levels/model";
import { createPostgresServerLevelStore } from "../src/runtime/postgres/postgres-server-level-store";
import { withFreshPostgres } from "./support/postgres";

test(
  "native awards apply once and clamp concurrent deductions to the available balance",
  { skip: process.env.TEST_POSTGRES_URL ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    await withFreshPostgres(async (database) => {
      const store = createPostgresServerLevelStore(database);
      const award = (id: string, xpUnits: number): ServerLevelAward => ({
        awardId: id,
        guildId: "guild",
        userId: "member",
        configuredGameServerId: null,
        sourceInboxId: null,
        kind: "support_adjustment",
        intervalStartedAtMs: null,
        intervalEndedAtMs: null,
        qualifyingSeconds: 0,
        multiplier: null,
        xpUnits,
        scoringPolicyVersion: 1,
        actorUserId: "staff",
        reason: "Synthetic adjustment",
        createdAtMs: 100,
      });
      const credits = await Promise.all(
        Array.from({ length: 6 }, () => store.appendAward(award("credit", 100))),
      );
      assert.equal(credits.filter((result) => result.applied).length, 1);
      const deductions = await Promise.all([
        store.appendAward(award("deduction-a", -80)),
        store.appendAward(award("deduction-b", -80)),
      ]);
      assert.deepEqual(
        deductions.map((result) => result.totalXpUnits).sort((a, b) => a - b),
        [0, 20],
      );
      const [ledger] = await database.query<{ total: number; count: number }>(
        "SELECT SUM(xp_units)::bigint AS total, COUNT(*)::bigint AS count FROM server_level_awards WHERE guild_id=$1 AND user_id=$2",
        ["guild", "member"],
      );
      assert.deepEqual(ledger, { total: 0, count: 3 });
      assert.equal((await store.appendAward(award("deduction-a", -80))).applied, false);
      assert.equal(
        (await store.appendAward(award("large-credit", 3_000_000_000))).totalXpUnits,
        3_000_000_000,
      );
      assert.equal(
        (await store.appendAward(award("large-deduction", -3_000_000_001))).totalXpUnits,
        0,
      );
    });
  },
);
