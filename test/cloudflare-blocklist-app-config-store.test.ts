/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareAppConfigStore } from "../src/runtime/cloudflare-app-config-store";
import { createCloudflareBlocklistStore } from "../src/runtime/cloudflare-blocklist-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

type BlocklistBatchStore = ReturnType<typeof createCloudflareBlocklistStore> & {
  applyGuildEmojiMutations(input: {
    guildId: string;
    emojis: string[];
    action: "add";
  }): Promise<unknown>;
};

test("Reaction Rules stores use the migrated unified database without runtime DDL", async () => {
  const database = new SqliteD1Database();
  const blocklist = createCloudflareBlocklistStore(
    database as unknown as D1Database,
    "bot-default",
  );
  const appConfig = createCloudflareAppConfigStore(database as unknown as D1Database);

  await appConfig.upsertAppConfig({ key: "bot_user_id", value: "bot-from-db" });
  await blocklist.applyGuildEmojiMutation({ guildId: "guild-1", emoji: "✅", action: "add" });
  assert.ok(blocklist.upsertGuildChannelFilter);
  await blocklist.upsertGuildChannelFilter({
    guildId: "guild-1",
    channelMode: "exclude",
    channelIds: ["channel-1"],
  });
  await blocklist.upsertGuildNotificationChannel({
    guildId: "guild-1",
    feature: "timed_roles",
    notificationChannelId: "log-channel-1",
  });

  assert.deepEqual(await blocklist.readConfig(), {
    botUserId: "bot-from-db",
    guilds: {
      "guild-1": {
        enabled: true,
        emojis: ["✅"],
        channelMode: "exclude",
        channelIds: ["channel-1"],
      },
    },
  });
  assert.equal(
    await blocklist.readGuildNotificationChannel("guild-1", "timed_roles"),
    "log-channel-1",
  );

  await blocklist.applyGuildEmojiMutation({ guildId: "guild-1", emoji: "✅", action: "remove" });
  assert.deepEqual(await blocklist.readConfig(), {
    botUserId: "bot-from-db",
    guilds: {
      "guild-1": {
        enabled: true,
        emojis: [],
        channelMode: "exclude",
        channelIds: ["channel-1"],
      },
    },
  });

  await blocklist.upsertGuildNotificationChannel({
    guildId: "guild-1",
    feature: "timed_roles",
    notificationChannelId: null,
  });
  assert.equal(await blocklist.readGuildNotificationChannel("guild-1", "timed_roles"), null);
  assert.equal(database.execCalls, 0);
});

test("Reaction Rules store applies batch emoji additions as one mutation", async () => {
  const database = new SqliteD1Database();
  const blocklist = createCloudflareBlocklistStore(
    database as unknown as D1Database,
    "bot-default",
  ) as BlocklistBatchStore;

  await blocklist.applyGuildEmojiMutations({
    guildId: "guild-1",
    emojis: ["✅", "🚫"],
    action: "add",
  });

  assert.deepEqual((await blocklist.readConfig()).guilds["guild-1"]?.emojis, ["✅", "🚫"]);
});

test("Gateway blocklist reads only the requested Guild while preserving the configured bot ID", async () => {
  const database = new SqliteD1Database();
  const blocklist = createCloudflareBlocklistStore(
    database as unknown as D1Database,
    "bot-default",
  );
  const appConfig = createCloudflareAppConfigStore(database as unknown as D1Database);

  await appConfig.upsertAppConfig({ key: "bot_user_id", value: "bot-from-db" });
  await blocklist.applyGuildEmojiMutation({ guildId: "guild-1", emoji: "✅", action: "add" });
  await blocklist.applyGuildEmojiMutation({ guildId: "guild-2", emoji: "🚫", action: "add" });

  database.prepareCalls.length = 0;
  assert.deepEqual(await blocklist.readGuildConfig("guild-1"), {
    botUserId: "bot-from-db",
    guilds: {
      "guild-1": {
        enabled: true,
        emojis: ["✅"],
        channelMode: "include",
        channelIds: [],
      },
    },
  });
  assert.equal(database.prepareCalls.length, 3);
  assert.ok(database.prepareCalls.every((query) => /\bwhere\b/i.test(query)));
});
