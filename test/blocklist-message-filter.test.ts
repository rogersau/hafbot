/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { moderateMessageCreate } from "../src/services/blocklist/message-filter";

for (const source of ["member", "bot", "webhook"] as const) {
  test(`Blocklist deletes ${source} messages but only DMs members`, async () => {
    const deleted: string[] = [];
    const notified: string[] = [];
    await moderateMessageCreate(
      {
        id: "message-1",
        channel_id: "channel-1",
        guild_id: "guild-1",
        content: "blocked 😈",
        author: { id: "author-1", bot: source === "bot" },
        ...(source === "webhook" ? { webhook_id: "webhook-1" } : {}),
      },
      { DISCORD_BOT_TOKEN: "bot-token", BOT_USER_ID: "haf-bot" },
      {
        resolveBotDisplayName: async () => "HAF Bot",
        readBlocklistForGuild: async () => ({
          guilds: { "guild-1": { enabled: true, emojis: ["😈"] } },
          botUserId: "haf-bot",
        }),
        deleteChannelMessage: async (_channelId, messageId) => {
          deleted.push(messageId);
        },
        createUserDmMessage: async (userId) => {
          notified.push(userId);
          return { id: "dm-1", channel_id: "dm-channel", content: "" };
        },
      },
    );
    assert.deepEqual(deleted, ["message-1"]);
    assert.deepEqual(notified, source === "member" ? ["author-1"] : []);
  });
}

test("moderateMessageCreate reads configuration for the selected Guild", async () => {
  const targetedGuilds: string[] = [];
  const deletedMessages: string[] = [];

  await moderateMessageCreate(
    {
      id: "message-targeted-1",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "blocked ✅",
      author: { id: "user-1" },
    },
    { DISCORD_BOT_TOKEN: "bot-token", BOT_USER_ID: "bot-1" },
    {
      resolveBotDisplayName: async () => "HAF Bot",

      readBlocklistForGuild: async (guildId) => {
        targetedGuilds.push(guildId);
        return {
          guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
          botUserId: "bot-1",
        };
      },
      deleteChannelMessage: async (_channelId, messageId) => {
        deletedMessages.push(messageId);
      },
      createUserDmMessage: async () => ({
        id: "dm-1",
        channel_id: "dm-channel-1",
        content: "not used",
      }),
    },
  );

  assert.deepEqual(targetedGuilds, ["guild-1"]);
  assert.deepEqual(deletedMessages, ["message-targeted-1"]);
});

test("moderateMessageCreate skips the bot's own messages", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];
  const dmMessages: Array<{ userId: string; token: string; content?: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-1",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "✅ hello",
      author: {
        id: "bot-1",
        username: "haf-bot",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["✅"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async (userId, body, token) => {
        dmMessages.push({ userId, token, content: body.content });
        return { id: "dm-1", channel_id: "dm-channel-1", content: body.content ?? "" };
      },
    },
  );

  assert.deepEqual(deletedMessages, []);
  assert.deepEqual(dmMessages, []);
});

test("moderateMessageCreate ignores messages without blocked emoji", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];
  const dmMessages: Array<{ userId: string; token: string; content?: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-2",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "hello there",
      author: {
        id: "user-1",
        username: "member-1",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["✅"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async (userId, body, token) => {
        dmMessages.push({ userId, token, content: body.content });
        return { id: "dm-1", channel_id: "dm-channel-1", content: body.content ?? "" };
      },
    },
  );

  assert.deepEqual(deletedMessages, []);
  assert.deepEqual(dmMessages, []);
});

test("moderateMessageCreate deletes messages containing blocked emoji and notifies the sender", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];
  const dmMessages: Array<{
    userId: string;
    token: string;
    content?: string;
    allowed_mentions?: unknown;
  }> = [];

  await moderateMessageCreate(
    {
      id: "message-3",
      channel_id: "channel-9",
      guild_id: "guild-1",
      content: "please no ✅ here",
      author: {
        id: "user-9",
        username: "member-9",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["✅"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async (userId, body, token) => {
        dmMessages.push({
          userId,
          token,
          content: body.content,
          allowed_mentions: body.allowed_mentions,
        });
        return { id: "dm-1", channel_id: "dm-channel-1", content: body.content ?? "" };
      },
    },
  );

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-9", messageId: "message-3", token: "bot-token" },
  ]);
  assert.deepEqual(dmMessages, [
    {
      userId: "user-9",
      token: "bot-token",
      content:
        "Your message was deleted by HAF Bot.\nWho sent it: <@user-9>\nMessage: please no ✅ here\nBlocked emoji: ✅\nReason: This guild blocks that emoji in messages.",
      allowed_mentions: { parse: [], users: ["user-9"] },
    },
  ]);
  assert.doesNotMatch(dmMessages[0]?.content ?? "", /\nID:/);
});

test("moderateMessageCreate uses White-Label Bot display name in DM when configured", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];
  const dmMessages: Array<{
    userId: string;
    token: string;
    content?: string;
    allowed_mentions?: unknown;
  }> = [];

  await moderateMessageCreate(
    {
      id: "message-wl-1",
      channel_id: "channel-9",
      guild_id: "guild-wl-1",
      content: "please no ✅ here",
      author: {
        id: "user-9",
        username: "member-9",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-wl-1": {
            enabled: true,
            emojis: ["✅"],
          },
        },
        botUserId: "bot-1",
      }),
      resolveBotDisplayName: async (guildId) =>
        guildId === "guild-wl-1" ? "Custom Bot" : "HAF Bot",
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async (userId, body, token) => {
        dmMessages.push({
          userId,
          token,
          content: body.content,
          allowed_mentions: body.allowed_mentions,
        });
        return { id: "dm-1", channel_id: "dm-channel-1", content: body.content ?? "" };
      },
    },
  );

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-9", messageId: "message-wl-1", token: "bot-token" },
  ]);
  assert.match(dmMessages[0]?.content ?? "", /Your message was deleted by Custom Bot\./);
  assert.doesNotMatch(dmMessages[0]?.content ?? "", /HAF Bot/);
});

test("moderateMessageCreate skips blocked emoji in excluded channels", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];
  const dmMessages: Array<{ userId: string; token: string; content?: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-excluded-1",
      channel_id: "channel-9",
      guild_id: "guild-1",
      content: "please no ✅ here",
      author: {
        id: "user-9",
        username: "member-9",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
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
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async (userId, body, token) => {
        dmMessages.push({ userId, token, content: body.content });
        return { id: "dm-1", channel_id: "dm-channel-1", content: body.content ?? "" };
      },
    },
  );

  assert.deepEqual(deletedMessages, []);
  assert.deepEqual(dmMessages, []);
});

test("moderateMessageCreate deletes messages when blocked emoji only differs by variation selector", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-vs16-1",
      channel_id: "channel-vs16-1",
      guild_id: "guild-1",
      content: "please no \u2705 here",
      author: {
        id: "user-vs16-1",
        username: "member-vs16-1",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["\u2705\uFE0F"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    },
  );

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-vs16-1", messageId: "message-vs16-1", token: "bot-token" },
  ]);
});

test("moderateMessageCreate matches blocked custom emoji by normalized name", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-4",
      channel_id: "channel-4",
      guild_id: "guild-1",
      content: "look <:blobcat:12345>",
      author: {
        id: "user-4",
        username: "member-4",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["blobcat:12345"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    },
  );

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-4", messageId: "message-4", token: "bot-token" },
  ]);
});

test("moderateMessageCreate deletes messages containing blocked custom emoji tone variants", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-tone-1",
      channel_id: "channel-tone-1",
      guild_id: "guild-1",
      content: "look <:pregnant_man_tone1:12345>",
      author: {
        id: "user-tone-1",
        username: "member-tone-1",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["pregnant_man:12345"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    },
  );

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-tone-1", messageId: "message-tone-1", token: "bot-token" },
  ]);
});

test("moderateMessageCreate ignores custom emoji with the same name but different id", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];

  await moderateMessageCreate(
    {
      id: "message-5",
      channel_id: "channel-5",
      guild_id: "guild-1",
      content: "look <:blobcat:99999>",
      author: {
        id: "user-5",
        username: "member-5",
      },
    },
    {
      DISCORD_BOT_TOKEN: "bot-token",
      BOT_USER_ID: "bot-1",
    },
    {
      resolveBotDisplayName: async () => "HAF Bot",
      readBlocklistForGuild: async () => ({
        guilds: {
          "guild-1": {
            enabled: true,
            emojis: ["blobcat:12345"],
          },
        },
        botUserId: "bot-1",
      }),
      deleteChannelMessage: async (channelId, messageId, token) => {
        deletedMessages.push({ channelId, messageId, token });
      },
      createUserDmMessage: async () => ({ id: "dm-1", channel_id: "dm-channel-1", content: "" }),
    },
  );

  assert.deepEqual(deletedMessages, []);
});

test("moderateMessageCreate keeps gateway handling alive when message deletion fails", async () => {
  await assert.doesNotReject(async () => {
    await moderateMessageCreate(
      {
        id: "message-6",
        channel_id: "channel-6",
        guild_id: "guild-1",
        content: "please no ✅ here",
        author: {
          id: "user-6",
          username: "member-6",
        },
      },
      {
        DISCORD_BOT_TOKEN: "bot-token",
        BOT_USER_ID: "bot-1",
      },
      {
        resolveBotDisplayName: async () => "HAF Bot",
        readBlocklistForGuild: async () => ({
          guilds: {
            "guild-1": {
              enabled: true,
              emojis: ["✅"],
            },
          },
          botUserId: "bot-1",
        }),
        deleteChannelMessage: async () => {
          throw new Error("delete failed");
        },
        createUserDmMessage: async () => {
          throw new Error("dm should not run after delete failure");
        },
      },
    );
  });
});

test("moderateMessageCreate keeps gateway handling alive when DM delivery fails", async () => {
  const deletedMessages: Array<{ channelId: string; messageId: string; token: string }> = [];

  await assert.doesNotReject(async () => {
    await moderateMessageCreate(
      {
        id: "message-7",
        channel_id: "channel-7",
        guild_id: "guild-1",
        content: "please no ✅ here",
        author: {
          id: "user-7",
          username: "member-7",
        },
      },
      {
        DISCORD_BOT_TOKEN: "bot-token",
        BOT_USER_ID: "bot-1",
      },
      {
        resolveBotDisplayName: async () => "HAF Bot",
        readBlocklistForGuild: async () => ({
          guilds: {
            "guild-1": {
              enabled: true,
              emojis: ["✅"],
            },
          },
          botUserId: "bot-1",
        }),
        deleteChannelMessage: async (channelId, messageId, token) => {
          deletedMessages.push({ channelId, messageId, token });
        },
        createUserDmMessage: async () => {
          throw new Error("dm failed");
        },
      },
    );
  });

  assert.deepEqual(deletedMessages, [
    { channelId: "channel-7", messageId: "message-7", token: "bot-token" },
  ]);
});
