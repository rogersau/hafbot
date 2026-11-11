import { deleteReaction } from "../src/discord";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { moderateReactionAdd } from "../src/services/blocklist/reaction-filter";

test("moderateReactionAdd reads configuration for the selected Guild", async () => {
  const targetedGuilds: string[] = [];
  const calls: Array<{ input: string; method: string }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 204 });
  });

  try {
    const outcome = await moderateReactionAdd(
      {
        channel_id: "channel-1",
        message_id: "message-1",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-1",
      },
      { DISCORD_BOT_TOKEN: "bot-token", BOT_USER_ID: "bot-1" },
      {
        deleteReaction,

        readBlocklistForGuild: async (guildId) => {
          targetedGuilds.push(guildId);
          return {
            guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
            botUserId: "bot-1",
          };
        },
      },
    );

    assert.equal(outcome, "removed");
  } finally {
    restore();
  }

  assert.deepEqual(targetedGuilds, ["guild-1"]);
  assert.equal(calls.length, 1);
});

test("moderateReactionAdd skips blocked emoji reactions in excluded channels", async () => {
  const calls: Array<{ input: string; method: string }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 204 });
  });

  try {
    await moderateReactionAdd(
      {
        channel_id: "channel-9",
        message_id: "message-9",
        guild_id: "guild-1",
        emoji: { id: null, name: "✅", animated: false },
        user_id: "user-9",
      },
      {
        DISCORD_BOT_TOKEN: "bot-token",
        BOT_USER_ID: "bot-1",
      },
      {
        deleteReaction,
        readBlocklistForGuild: async () => ({
          guilds: {
            "guild-1": {
              enabled: true,
              emojis: ["✅"],
              channelMode: "exclude",
              channelIds: ["channel-9"],
            },
          },
          botUserId: "bot-1",
        }),
      },
    );
  } finally {
    restore();
  }

  assert.deepEqual(calls, []);
});

function interceptDiscordFetch(handler: typeof fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return { restore: () => (globalThis.fetch = originalFetch) };
}
