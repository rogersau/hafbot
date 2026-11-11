/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import {
  buildBlocklistConfig,
  channelMatchesFilter,
  getBlocklistFromStore,
  isEmojiBlocked,
  normalizeEmoji,
  parseBlocklistEmojis,
} from "../src/blocklist";
import { BlocklistService } from "../src/services/blocklist-service";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

test("buildBlocklistConfig materializes guild rules", () => {
  const config = buildBlocklistConfig(
    [{ guild_id: "guild-disabled", moderation_enabled: 0 }],
    [{ guild_id: "guild-1", normalized_emoji: "❌" }],
    [{ key: "bot_user_id", value: "bot-1" }],
  );

  assert.equal(isEmojiBlocked("❌", config, "guild-1"), true);
  assert.equal(config.guilds["guild-disabled"]?.enabled, false);
  assert.deepEqual(config.guilds["guild-disabled"]?.channelIds, []);
  assert.equal(config.botUserId, "bot-1");
});

test("buildBlocklistConfig materializes channel filters", () => {
  const config = buildBlocklistConfig(
    [
      {
        guild_id: "guild-1",
        moderation_enabled: 1,
        channel_mode: "include",
        channel_ids_json: JSON.stringify(["channel-1"]),
      },
    ],
    [{ guild_id: "guild-1", normalized_emoji: "❌" }],
    [],
  );

  assert.equal(isEmojiBlocked("❌", config, "guild-1", "channel-1"), true);
  assert.equal(isEmojiBlocked("❌", config, "guild-1", "channel-2"), false);
});

test("channelMatchesFilter handles default, include, and exclude filters", () => {
  assert.equal(channelMatchesFilter(undefined, []), true);
  assert.equal(channelMatchesFilter("include", []), true);
  assert.equal(channelMatchesFilter("exclude", []), true);
  assert.equal(channelMatchesFilter("include", ["channel-1"], "channel-1"), true);
  assert.equal(channelMatchesFilter("include", ["channel-1"], "channel-2"), false);
  assert.equal(channelMatchesFilter("exclude", ["channel-1"], "channel-1"), false);
  assert.equal(channelMatchesFilter("exclude", ["channel-1"], "channel-2"), true);
});

test("guild-specific blocklists stay isolated per guild", () => {
  const config = buildBlocklistConfig(
    [
      { guild_id: "guild-disabled", moderation_enabled: 0 },
      { guild_id: "guild-1", moderation_enabled: 1 },
    ],
    [
      { guild_id: "guild-disabled", normalized_emoji: "❌" },
      { guild_id: "guild-1", normalized_emoji: "✅" },
    ],
    [],
  );

  assert.equal(isEmojiBlocked("✅", config, "guild-1"), true);
  assert.equal(isEmojiBlocked("❌", config, "guild-1"), false);
  assert.equal(isEmojiBlocked("❌", config, "guild-disabled"), false);
  assert.equal(isEmojiBlocked("✅", config, "guild-disabled"), false);
});

test("base custom emoji block also blocks tone variants", () => {
  const config = buildBlocklistConfig(
    [{ guild_id: "guild-1", moderation_enabled: 1 }],
    [{ guild_id: "guild-1", normalized_emoji: "pregnant_man:12345" }],
    [],
  );

  assert.equal(isEmojiBlocked("pregnant_man_tone1:12345", config, "guild-1"), true);
});

test("missing bot_user_id materializes as an empty string", () => {
  const config = buildBlocklistConfig([], [], []);

  assert.equal(config.botUserId, "");
});

test("legacy top-level emojis are ignored when evaluating the blocklist", () => {
  const config = buildBlocklistConfig([], [], []);

  assert.equal(isEmojiBlocked("✅", config, "guild-1"), false);
});

test("normalizeEmoji handles null and empty input", () => {
  assert.equal(normalizeEmoji(null), null);
  assert.equal(normalizeEmoji(""), null);
  assert.equal(normalizeEmoji(":blobcat:"), "blobcat");
});

test("parseBlocklistEmojis separates multiple emoji from one input", () => {
  assert.deepEqual(parseBlocklistEmojis("✅🚫"), ["✅", "🚫"]);
  assert.deepEqual(parseBlocklistEmojis("✅ 🚫"), ["✅", "🚫"]);
  assert.deepEqual(parseBlocklistEmojis("<:blobcat:123><a:party:456>"), [
    "<:blobcat:123>",
    "<a:party:456>",
  ]);
});

test("getBlocklistFromStore reads the latest config from the moderation store", async () => {
  const expected = buildBlocklistConfig(
    [{ guild_id: "guild-1", moderation_enabled: 1 }],
    [{ guild_id: "guild-1", normalized_emoji: "❌" }],
    [{ key: "bot_user_id", value: "bot-1" }],
  );

  const actual = await getBlocklistFromStore(() => Promise.resolve(Response.json(expected)));

  assert.deepEqual(actual, expected);
});
test("getGuildBlocklist returns an enabled empty state for unknown guilds", async (t) => {
  const fixture = createProductionRuntimeStores({ botUserId: "bot" });
  t.after(() => fixture.close());
  const service = new BlocklistService(fixture.stores.blocklist);

  const result = await service.getGuildBlocklist("missing-guild");

  assert.deepEqual(result, { enabled: true, emojis: [], channelMode: "include", channelIds: [] });
});
