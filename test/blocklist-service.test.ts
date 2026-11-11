/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import type { CreateChannelMessageInput } from "../src/discord/messages";
import type { BlocklistStore, GuildEntitlementStore } from "../src/runtime/contracts";
import { BlocklistService } from "../src/services/blocklist-service";

import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";

type TestBlocklistStore = BlocklistStore;

test("BlocklistService.addEmoji persists the emoji and posts a moderation update", async () => {
  const { store } = createBlocklistFixture([], "log-channel-1");
  const postedMessages: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];
  const service = new BlocklistService(store, async (channelId, body) => {
    postedMessages.push({ channelId, body });
  });

  const result = await service.addEmoji("guild-1", "✅", {
    label: "Slash command",
    userId: "admin-1",
  });

  assert.equal(result.alreadyBlocked, false);
  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis, ["✅"]);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0]?.channelId, "log-channel-1");
  assert.equal(postedMessages[0]?.body.content, undefined);
  assert.equal(postedMessages[0]?.body.embeds?.[0]?.title, "🧱 Blocklist Update");
  assert.deepEqual(postedMessages[0]?.body.embeds?.[0]?.fields, [
    { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
    { name: "Action", value: "Added", inline: false },
    { name: "Emoji", value: "✅", inline: false },
  ]);
  assert.deepEqual(postedMessages[0]?.body.embeds?.[0]?.footer, { text: "hafbot.xyz" });
  assert.match(postedMessages[0]?.body.embeds?.[0]?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(postedMessages[0]?.body.allowed_mentions, { parse: [] });
});

test("BlocklistService does not notify or write for a duplicate add", async () => {
  const { store } = createBlocklistFixture(["✅"], "log-channel-1");
  const postedMessages: unknown[] = [];
  const service = new BlocklistService(store, async (_channelId, body) => {
    postedMessages.push(body);
  });

  assert.deepEqual(await service.addEmoji("guild-1", "✅"), { alreadyBlocked: true });
  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis, ["✅"]);
  assert.deepEqual(postedMessages, []);
});

test("BlocklistService.removeEmoji persists removal and posts an audit embed", async () => {
  const { store } = createBlocklistFixture(["✅"], "log-channel-1");
  const postedMessages: Array<{ channelId: string; body: CreateChannelMessageInput }> = [];
  const service = new BlocklistService(store, async (channelId, body) => {
    postedMessages.push({ channelId, body });
  });

  assert.deepEqual(
    await service.removeEmoji("guild-1", "✅", { label: "Slash command", userId: "admin-1" }),
    { wasBlocked: true },
  );

  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis, []);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0]?.channelId, "log-channel-1");
  assert.deepEqual(postedMessages[0]?.body.embeds?.[0]?.fields, [
    { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
    { name: "Action", value: "Removed", inline: false },
    { name: "Emoji", value: "✅", inline: false },
  ]);
  assert.deepEqual(postedMessages[0]?.body.allowed_mentions, { parse: [] });
});

test("BlocklistService.removeEmoji normalizes custom Discord markup", async () => {
  const { store } = createBlocklistFixture(["party_blob:222"]);
  const service = new BlocklistService(store);

  assert.deepEqual(await service.removeEmoji("guild-1", "<a:party_blob:222>"), {
    wasBlocked: true,
  });
  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis, []);
});

test("BlocklistService rejects an 11th distinct emoji for a free Guild", async () => {
  const emojis = Array.from({ length: 10 }, (_, index) => `emoji-${index + 1}`);
  const { store, entitlements } = createBlocklistFixture(emojis);
  const service = new BlocklistService(store, undefined, entitlements);

  await assert.rejects(service.addEmoji("guild-1", "emoji-11"), /Free servers can block up to 10/);
  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis.sort(), emojis.sort());
});

test("BlocklistService keeps duplicate adds idempotent at the free limit", async () => {
  const emojis = Array.from({ length: 10 }, (_, index) => `emoji-${index + 1}`);
  const { store, entitlements } = createBlocklistFixture(emojis);
  const service = new BlocklistService(store, undefined, entitlements);

  assert.deepEqual(await service.addEmoji("guild-1", "emoji-10"), { alreadyBlocked: true });
});

test("BlocklistService allows premium Guilds past the free emoji limit", async () => {
  const emojis = Array.from({ length: 10 }, (_, index) => `emoji-${index + 1}`);
  const { store, entitlements } = createBlocklistFixture(emojis, null, "premium");
  const service = new BlocklistService(store, undefined, entitlements);

  assert.deepEqual(await service.addEmoji("guild-1", "emoji-11"), { alreadyBlocked: false });
  assert.equal((await service.getGuildBlocklist("guild-1")).emojis.includes("emoji-11"), true);
});

test("BlocklistService.addEmojis writes and notifies only for new emoji", async () => {
  const { store } = createBlocklistFixture(["✅"], "log-channel-1");
  const postedMessages: CreateChannelMessageInput[] = [];
  const service = new BlocklistService(store, async (_channelId, body) => {
    postedMessages.push(body);
  });

  assert.deepEqual(
    await service.addEmojis("guild-1", ["✅", "🚫", "🍎"], {
      label: "Slash command",
      userId: "admin-1",
    }),
    { added: ["🚫", "🍎"], alreadyBlocked: ["✅"] },
  );
  assert.deepEqual(
    (await service.getGuildBlocklist("guild-1")).emojis.sort(),
    ["✅", "🚫", "🍎"].sort(),
  );
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0]?.embeds?.[0]?.fields, [
    { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
    { name: "Action", value: "Added", inline: false },
    { name: "Emojis", value: "🚫, 🍎", inline: false },
  ]);
});

test("BlocklistService.addEmojis normalizes and de-duplicates Unicode and server emoji", async () => {
  const { store } = createBlocklistFixture(["🚫", "verified:111"], "log-channel-1");
  const service = new BlocklistService(store);

  assert.deepEqual(
    await service.addEmojis("guild-1", [
      " ✅ ",
      ":verified:111",
      "<a:party_blob:222>",
      "✅",
      ":party_blob:222",
    ]),
    { added: ["✅", "party_blob:222"], alreadyBlocked: ["verified:111"] },
  );
  assert.deepEqual(
    (await service.getGuildBlocklist("guild-1")).emojis.sort(),
    ["🚫", "✅", "party_blob:222", "verified:111"].sort(),
  );
});

test("BlocklistService.addEmojis does not notify when all emoji are already blocked", async () => {
  const { store } = createBlocklistFixture(["✅", "🚫"], "log-channel-1");
  const postedMessages: unknown[] = [];
  const service = new BlocklistService(store, async (_channelId, body) => {
    postedMessages.push(body);
  });

  assert.deepEqual(await service.addEmojis("guild-1", ["✅", "🚫"]), {
    added: [],
    alreadyBlocked: ["✅", "🚫"],
  });
  assert.deepEqual(postedMessages, []);
});

test("BlocklistService.addEmojis rejects a batch that exceeds the free limit", async () => {
  const emojis = Array.from({ length: 9 }, (_, index) => `emoji-${index + 1}`);
  const { store, entitlements } = createBlocklistFixture(emojis);
  const service = new BlocklistService(store, undefined, entitlements);

  await assert.rejects(
    service.addEmojis("guild-1", ["emoji-10", "emoji-11"]),
    /Free servers can block up to 10/,
  );
  assert.equal((await service.getGuildBlocklist("guild-1")).emojis.length, 9);
});

test("BlocklistService.addEmojis persists a batch that fits the free limit", async () => {
  const emojis = Array.from({ length: 8 }, (_, index) => `emoji-${index + 1}`);
  const { store, entitlements } = createBlocklistFixture(emojis);
  const service = new BlocklistService(store, undefined, entitlements);

  assert.deepEqual(await service.addEmojis("guild-1", ["emoji-9", "emoji-10"]), {
    added: ["emoji-9", "emoji-10"],
    alreadyBlocked: [],
  });
  assert.equal((await service.getGuildBlocklist("guild-1")).emojis.length, 10);
});

test("BlocklistService toggles Guild enforcement without dropping its rules", async () => {
  const { store } = createBlocklistFixture(["✅"]);
  const service = new BlocklistService(store);

  await service.setEnabled("guild-1", false);
  assert.deepEqual(await service.getGuildBlocklist("guild-1"), {
    enabled: false,
    emojis: ["✅"],
    channelMode: "include",
    channelIds: [],
  });

  await service.setEnabled("guild-1", true);
  assert.equal((await service.getGuildBlocklist("guild-1")).enabled, true);
});

test("BlocklistService rolls back a multi-emoji batch when one write fails", async () => {
  const { store, database } = createBlocklistFixture();
  database.execRaw(`CREATE TRIGGER reject_second_blocked_emoji
    BEFORE INSERT ON guild_blocked_emojis
    WHEN NEW.normalized_emoji = 'emoji-2'
    BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END`);
  const service = new BlocklistService(store);

  await assert.rejects(
    service.addEmojis("guild-1", ["emoji-1", "emoji-2"]),
    /injected batch failure/,
  );
  assert.deepEqual((await service.getGuildBlocklist("guild-1")).emojis, []);
});

test("BlocklistService updates and reads the Guild channel filter through production storage", async () => {
  const { store } = createBlocklistFixture();
  const service = new BlocklistService(store);

  await service.updateGuildChannelFilter("guild-1", "exclude", ["channel-1", "channel-2"]);

  assert.deepEqual(await service.getGuildBlocklist("guild-1"), {
    enabled: true,
    emojis: [],
    channelMode: "exclude",
    channelIds: ["channel-1", "channel-2"],
  });
});

function createBlocklistFixture(
  emojis: string[] = [],
  notificationChannelId: string | null = null,
  tier: "free" | "premium" = "free",
): {
  store: TestBlocklistStore;
  entitlements: GuildEntitlementStore;
  database: ReturnType<typeof createProductionRuntimeStores>["database"];
} {
  const fixture = createProductionRuntimeStores({ botUserId: "bot-1" });
  if (tier === "premium") {
    fixture.database.execRaw(
      "INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', 'premium', 1)",
    );
  }
  const rawStore = fixture.stores.blocklist as TestBlocklistStore;
  const ready = (async () => {
    for (const emoji of emojis) {
      await rawStore.applyGuildEmojiMutation({ guildId: "guild-1", emoji, action: "add" });
    }
    if (notificationChannelId) {
      await rawStore.upsertGuildNotificationChannel({
        guildId: "guild-1",
        feature: "blocklist",
        notificationChannelId,
      });
    }
  })();
  return {
    store: afterStoreSeed(rawStore, ready),
    entitlements: fixture.stores.guildEntitlements,
    database: fixture.database,
  };
}
