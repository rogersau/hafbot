/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  handleApplicationCommand,
  listCurrentServerLevelLeaderboard,
} from "../src/runtime/application-command-handler";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { createCloudflareServerLevelStore } from "../src/runtime/cloudflare-server-level-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("Server Levels leaderboard rechecks current Guild membership across stale pages", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  try {
    for (let index = 0; index < 30; index += 1) {
      await appendTotal(store, `former-${String(index).padStart(2, "0")}`, 10_000 - index);
    }
    await appendTotal(store, "current-a", 100);
    await appendTotal(store, "current-b", 50);

    const profiles = await listCurrentServerLevelLeaderboard(
      store,
      "guild-1",
      2,
      async (userId) => (userId.startsWith("current-") ? { id: userId } : null),
      50_000,
    );

    assert.deepEqual(
      profiles.map((profile) => profile.userId),
      ["current-a", "current-b"],
    );
    assert.equal((await store.listLeaderboard("guild-1", 100)).length, 2);
  } finally {
    database.close();
  }
});

test("a retried support interaction appends its Server XP adjustment only once", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ user: { id: "target-user" }, roles: [], joined_at: new Date().toISOString() });
  try {
    const interaction = {
      id: "support-interaction-1",
      guild_id: "haf-admin-guild",
      member: { user: { id: "support-user" }, roles: ["haf-admin-role"] },
      data: {
        name: "haf-admin",
        options: [
          {
            type: 1,
            name: "adjust-server-xp",
            options: [
              { type: 3, name: "guild_id", value: "target-guild" },
              { type: 3, name: "user_id", value: "target-user" },
              { type: 4, name: "amount_xp", value: 5 },
              { type: 3, name: "reason", value: "Correct imported attendance" },
            ],
          },
        ],
      },
    } as any;
    const options = { hafAdminGuildId: "haf-admin-guild", hafAdminRoleId: "haf-admin-role" };

    await handleApplicationCommand(
      interaction,
      fixture.stores,
      "discord-token",
      ALL_FEATURES_ENABLED,
      options,
    );
    await handleApplicationCommand(
      interaction,
      fixture.stores,
      "discord-token",
      ALL_FEATURES_ENABLED,
      options,
    );

    assert.equal(
      (await fixture.stores.serverLevels!.readProfile("target-guild", "target-user"))?.totalXpUnits,
      300,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("a restricted support interaction completes Server Levels personal-data erasure", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    await appendTotal(fixture.stores.serverLevels!, "target-user", 600);
    const interaction = {
      id: "erasure-interaction-1",
      guild_id: "haf-admin-guild",
      member: { user: { id: "support-user" }, roles: ["haf-admin-role"] },
      data: {
        name: "haf-admin",
        options: [
          {
            type: 1,
            name: "erase-server-level-data",
            options: [
              { type: 3, name: "guild_id", value: "guild-1" },
              { type: 3, name: "user_id", value: "target-user" },
              { type: 3, name: "reason", value: "Verified privacy request" },
            ],
          },
        ],
      },
    } as any;

    const response = await handleApplicationCommand(
      interaction,
      fixture.stores,
      "discord-token",
      ALL_FEATURES_ENABLED,
      { hafAdminGuildId: "haf-admin-guild", hafAdminRoleId: "haf-admin-role" },
    );

    assert.equal(response.status, 200);
    assert.equal(await fixture.stores.serverLevels!.readProfile("guild-1", "target-user"), null);
  } finally {
    fixture.close();
  }
});

async function appendTotal(
  store: ReturnType<typeof createCloudflareServerLevelStore>,
  userId: string,
  xpUnits: number,
) {
  await store.appendAward({
    awardId: `award-${userId}`,
    guildId: "guild-1",
    userId,
    configuredGameServerId: null,
    sourceInboxId: null,
    kind: "support_adjustment",
    intervalStartedAtMs: null,
    intervalEndedAtMs: null,
    qualifyingSeconds: 0,
    multiplier: null,
    xpUnits,
    scoringPolicyVersion: 1,
    actorUserId: "support",
    reason: "Test",
    createdAtMs: 1,
  });
}
