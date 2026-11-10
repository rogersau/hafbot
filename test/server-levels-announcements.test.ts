/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createCloudflareServerLevelStore } from "../src/runtime/cloudflare-server-level-store";
import { deliverPendingLevelAnnouncements } from "../src/runtime/server-level-queue-consumer";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Server Level announcement retries use a stable enforced Discord nonce", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareServerLevelStore(database.d1);
  const bodies: Array<{ nonce?: string; enforce_nonce?: boolean }> = [];
  let attempts = 0;
  try {
    await store.enqueueLevelAnnouncement({
      announcementId: "server-level:guild-1:user-1:2",
      guildId: "guild-1",
      userId: "user-1",
      channelId: "channel-1",
      level: 2,
      createdAtMs: 1,
    });
    const send = async (_channelId: string, body: (typeof bodies)[number]) => {
      bodies.push(body);
      attempts += 1;
      if (attempts === 1) throw new Error("response lost after provider accepted message");
      return {} as never;
    };

    await deliverPendingLevelAnnouncements(
      { DISCORD_BOT_TOKEN: "bot-token" },
      store,
      () => attempts,
      () => undefined,
      send as never,
    );
    await deliverPendingLevelAnnouncements(
      { DISCORD_BOT_TOKEN: "bot-token" },
      store,
      () => attempts,
      () => undefined,
      send as never,
    );

    assert.equal(typeof bodies[0]?.nonce, "string");
    assert.ok(bodies[0]!.nonce!.length <= 25);
    assert.match(bodies[0]!.nonce!, /^sl_[a-f0-9]{16}$/);
    assert.deepEqual(
      bodies.map(({ nonce, enforce_nonce }) => ({ nonce, enforce_nonce })),
      [
        { nonce: bodies[0]!.nonce, enforce_nonce: true },
        { nonce: bodies[0]!.nonce, enforce_nonce: true },
      ],
    );
    assert.deepEqual(await store.listPendingLevelAnnouncements(10), []);
  } finally {
    database.close();
  }
});
