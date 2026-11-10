/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import type { MarketplaceStore } from "../src/runtime/contracts";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  buildMarketplaceAdditionalChoiceResponse,
  buildMarketplaceNoticeMessage,
  buildMarketplacePostMessage,
  buildMarketplacePostModal,
  buildMarketplaceServerResponse,
  buildMarketplaceWarningResponse,
  parseMarketplaceCustomId,
} from "../src/marketplace";
import {
  MarketplaceActivePostError,
  MarketplaceService,
} from "../src/services/marketplace-service";
import type { MarketplaceBusinessLog, MarketplaceConfig, MarketplacePost } from "../src/types";

test("marketplace custom IDs parse supported actions", () => {
  assert.deepEqual(parseMarketplaceCustomId("market:create"), { action: "create" });
  assert.deepEqual(parseMarketplaceCustomId("market:type:have"), {
    action: "type",
    tradeType: "have",
  });
  assert.deepEqual(parseMarketplaceCustomId("market:server:want:namalsk:16"), {
    action: "server",
    tradeType: "want",
    serverId: "namalsk",
    flowUpdatedAtMs: 42,
  });
  assert.deepEqual(parseMarketplaceCustomId("market:modal:have:chernarus"), {
    action: "modal",
    tradeType: "have",
    serverId: "chernarus",
    choiceIndexes: [],
    flowUpdatedAtMs: null,
  });
  assert.deepEqual(parseMarketplaceCustomId("market:choice:have:namalsk:1:2:0:16"), {
    action: "choice",
    tradeType: "have",
    serverId: "namalsk",
    choiceIndex: 1,
    optionIndex: 2,
    choiceIndexes: [0],
    flowUpdatedAtMs: 42,
  });
  assert.deepEqual(parseMarketplaceCustomId("market:biz:post-1"), {
    action: "business",
    postId: "post-1",
  });
  assert.equal(parseMarketplaceCustomId("ticket:open:support"), null);
});

test("marketplace noticeboard uses the configured embed and create button", () => {
  const message = buildMarketplaceNoticeMessage({
    ...createConfig(),
    noticeEmbed: {
      title: "Trading Hub",
      description: "Buy, sell, and swap with the community.",
      color: 0xff6600,
      buttonLabel: "Start a post",
      buttonEmoji: "🛒",
    },
  } as MarketplaceConfig);

  assert.deepEqual(message.embeds[0], {
    title: "Trading Hub",
    description: "Buy, sell, and swap with the community.",
    color: 0xff6600,
  });
  assert.equal(message.components[0].components[0].label, "Start a post");
  assert.deepEqual(message.components[0].components[0].emoji, { name: "🛒" });
});

test("marketplace builders create Discord modal and warning responses", () => {
  const modal = buildMarketplacePostModal("have", "namalsk");
  assert.equal(modal.type, 9);
  assert.equal(modal.data.custom_id, "market:modal:have:namalsk");
  assert.equal(modal.data.components[0].components[0].custom_id, "have");
  assert.equal(modal.data.components[0].components[0].required, true);
  assert.equal(modal.data.components[1].components[0].required, false);

  const warning = buildMarketplaceWarningResponse("post-1");
  assert.equal(warning.type, 4);
  assert.equal(warning.data.flags, 64);
  assert.match(warning.data.content, /Scamming/);
  assert.equal(warning.data.components[0].components[0].custom_id, "market:confirm:post-1");
});

test("marketplace server response uses configured server options", () => {
  const response = buildMarketplaceServerResponse(createConfig(), "want");
  assert.equal(response.type, 7);
  assert.equal(response.data.components[0].components[0].custom_id, "market:server:want:namalsk:1");
  assert.equal(response.data.components[0].components[1].label, "Chernarus");
});

test("marketplace additional choice response presents the configured options", () => {
  const response = buildMarketplaceAdditionalChoiceResponse(
    {
      ...createConfig(),
      additionalChoicesEnabled: true,
      additionalChoices: [
        {
          id: "listing-type",
          label: "What kind of listing is this?",
          options: [
            { id: "weapon", label: "Weapon", emoji: "🔫" },
            { id: "vehicle", label: "Vehicle", emoji: "🚙" },
          ],
        },
      ],
    },
    "have",
    "namalsk",
    0,
    [],
  );

  assert.equal(response.type, 7);
  assert.equal(response.data.content, "What kind of listing is this?");
  assert.equal(
    response.data.components[0].components[1].custom_id,
    "market:choice:have:namalsk:0:1:~:1",
  );
  assert.deepEqual(response.data.components[0].components[0].emoji, { name: "🔫" });
});

test("marketplace post message renders owner as a mention without a raw ID line", () => {
  const msg = buildMarketplacePostMessage(createPost());
  const postedByField = msg.embeds[0].fields.find((field) => field.name === "Posted by");

  assert.equal(postedByField?.value, "<@owner-1>");
  assert.doesNotMatch(postedByField?.value ?? "", /\nID:/);
});

test("MarketplaceService creates posts and rejects duplicate active owner posts", async () => {
  const store = createStore();
  const discordCalls: string[] = [];
  const service = new MarketplaceService(store, {
    async createChannelMessage(channelId) {
      discordCalls.push(`message:${channelId}`);
      return { id: `message-${discordCalls.length}`, channel_id: channelId, content: "" };
    },
    async editChannelMessage() {
      throw new Error("unexpected edit");
    },
    async deleteChannelMessage() {
      discordCalls.push("delete-notice");
    },
    async createUserDmMessage() {
      throw new Error("unexpected dm");
    },
  });

  const post = await service.createPost({
    guildId: "guild-1",
    channelId: "channel-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    tradeType: "have",
    serverId: "namalsk",
    have: "M4A1",
    want: "NVGs",
    extra: "Safe zone",
  });

  assert.equal(post.messageId, "message-1");
  assert.equal(store.posts.length, 1);
  assert.deepEqual(discordCalls, ["message:channel-1", "message:channel-1"]);
  await assert.rejects(
    service.createPost({
      guildId: "guild-1",
      channelId: "channel-1",
      ownerId: "owner-1",
      ownerDisplayName: "Owner",
      tradeType: "want",
      serverId: "namalsk",
      have: "",
      want: "Ammo",
      extra: "",
    }),
    MarketplaceActivePostError,
  );
});

test("MarketplaceService rolls back a pending post when Discord publish fails", async () => {
  const store = createStore();
  let publishAttempts = 0;
  const service = new MarketplaceService(store, {
    async createChannelMessage(channelId) {
      publishAttempts += 1;
      if (publishAttempts === 1) throw new Error("Discord rate limited");
      return { id: `message-${publishAttempts}`, channel_id: channelId, content: "" };
    },
    async editChannelMessage() {
      throw new Error("unexpected edit");
    },
    async deleteChannelMessage() {},
    async createUserDmMessage() {
      throw new Error("unexpected dm");
    },
  });
  const input = {
    guildId: "guild-1",
    channelId: "channel-1",
    ownerId: "owner-retry",
    ownerDisplayName: "Owner",
    tradeType: "have" as const,
    serverId: "namalsk",
    have: "M4A1",
    want: "NVGs",
    extra: "",
  };

  await assert.rejects(service.createPost(input), /Discord rate limited/);
  assert.equal(store.posts[0]?.active, false);

  const retried = await service.createPost(input);
  assert.equal(retried.active, true);
  assert.equal(retried.messageId, "message-2");
});

test("MarketplaceService creates a Marketplace Post without a server and records additional choices", async () => {
  const store = createStore();
  Object.assign(store.config, {
    serverChoiceEnabled: false,
    additionalChoicesEnabled: true,
    additionalChoices: [
      {
        id: "listing-type",
        label: "Listing type",
        options: [
          { id: "weapon", label: "Weapon", emoji: null },
          { id: "vehicle", label: "Vehicle", emoji: null },
        ],
      },
    ],
  });
  const messages: unknown[] = [];
  const service = new MarketplaceService(store, {
    async createChannelMessage(_channelId, body) {
      messages.push(body);
      return { id: `message-${messages.length}`, channel_id: "channel-1", content: "" };
    },
    async editChannelMessage() {
      throw new Error("unexpected edit");
    },
    async deleteChannelMessage() {},
    async createUserDmMessage() {
      throw new Error("unexpected dm");
    },
  });

  const post = await service.createPost({
    guildId: "guild-1",
    channelId: "channel-1",
    ownerId: "owner-2",
    ownerDisplayName: "Owner Two",
    tradeType: "want",
    serverId: "",
    choiceIndexes: [1],
    have: "",
    want: "Truck",
    extra: "",
  });

  assert.equal(post.serverId, "");
  assert.equal(post.serverLabel, "");
  assert.deepEqual(post.additionalChoices, [
    {
      choiceId: "listing-type",
      choiceLabel: "Listing type",
      optionId: "vehicle",
      optionLabel: "Vehicle",
    },
  ]);
  const postMessage = messages[0] as { embeds?: Array<{ fields?: Array<{ name: string }> }> };
  assert.deepEqual(
    postMessage.embeds?.[0].fields?.map((field) => field.name),
    [
      "Type",
      "Listing type",
      "What do you have for trade?",
      "Is there something you are looking for?",
      "Extra info",
      "Posted by",
    ],
  );
});

test("MarketplaceService rejects an in-progress form after marketplace choices change", async () => {
  const store = createStore();
  Object.assign(store.config, {
    additionalChoicesEnabled: true,
    additionalChoices: [
      {
        id: "listing-type",
        label: "Listing type",
        options: [
          { id: "weapon", label: "Weapon", emoji: null },
          { id: "vehicle", label: "Vehicle", emoji: null },
        ],
      },
    ],
    updatedAtMs: 200,
  });
  const service = new MarketplaceService(store, {
    async createChannelMessage() {
      throw new Error("unexpected message");
    },
    async editChannelMessage() {
      throw new Error("unexpected edit");
    },
    async deleteChannelMessage() {},
    async createUserDmMessage() {
      throw new Error("unexpected dm");
    },
  });

  await assert.rejects(
    service.createPost({
      guildId: "guild-1",
      channelId: "channel-1",
      ownerId: "owner-3",
      ownerDisplayName: "Owner Three",
      tradeType: "have",
      serverId: "namalsk",
      flowUpdatedAtMs: 100,
      choiceIndexes: [0],
      have: "Rifle",
      want: "",
      extra: "",
    }),
    /Marketplace settings changed while you were creating this post/,
  );
});

test("MarketplaceService confirms business, logs DM success, and posts admin log", async () => {
  const store = createStore();
  store.posts.push(createPost());
  const discordCalls: string[] = [];
  const dms: Array<{ userId: string; body: unknown }> = [];
  const service = new MarketplaceService(store, {
    async createChannelMessage(channelId) {
      discordCalls.push(`channel:${channelId}`);
      return { id: "message-1", channel_id: channelId, content: "" };
    },
    async editChannelMessage() {
      throw new Error("unexpected edit");
    },
    async deleteChannelMessage() {
      throw new Error("unexpected delete");
    },
    async createUserDmMessage(userId, body) {
      dms.push({ userId, body });
      discordCalls.push(`dm:${userId}`);
      return { id: "dm-1", channel_id: "dm-channel", content: "" };
    },
  });

  const result = await service.confirmBusiness({
    guildId: "guild-1",
    postId: "post-1",
    buyerId: "buyer-1",
    buyerDisplayName: "Buyer",
  });

  assert.deepEqual(result, { dmSent: true });
  assert.equal(store.logs.length, 1);
  assert.equal(store.logs[0]?.buyerId, "buyer-1");
  assert.equal(store.logs[0]?.dmSent, true);
  assert.deepEqual(discordCalls, ["dm:owner-1", "channel:log-channel-1"]);
  const dmBody = dms[0]?.body as { content?: string; allowed_mentions?: unknown };
  assert.match(dmBody.content ?? "", /User: <@buyer-1> \(Buyer\)/);
  assert.doesNotMatch(dmBody.content ?? "", /\nID:/);
  assert.deepEqual(dmBody.allowed_mentions, { parse: [], users: ["buyer-1"] });
});

test("MarketplaceService posts standardized business log embeds", async () => {
  const baseNow = Date.UTC(2026, 0, 1, 12, 0, 0);
  const originalDateNow = Date.now;
  Date.now = () => baseNow;
  const store = createStore();
  store.posts.push(createPost());
  const channelMessages: Array<{ channelId: string; body: unknown }> = [];

  try {
    const service = new MarketplaceService(store, {
      async createChannelMessage(channelId, body) {
        channelMessages.push({ channelId, body });
        return { id: "message-1", channel_id: channelId, content: body.content ?? "" };
      },
      async editChannelMessage() {
        throw new Error("unexpected edit");
      },
      async deleteChannelMessage() {
        throw new Error("unexpected delete");
      },
      async createUserDmMessage() {
        return { id: "dm-1", channel_id: "dm-channel", content: "" };
      },
    });

    await service.confirmBusiness({
      guildId: "guild-1",
      postId: "post-1",
      buyerId: "buyer-1",
      buyerDisplayName: "Buyer",
    });

    assert.equal(channelMessages[0]?.channelId, "log-channel-1");
    const body = channelMessages[0]?.body as {
      embeds?: Array<{
        title?: string;
        description?: string;
        color?: number;
        footer?: { text: string };
        timestamp?: string;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
      }>;
    };
    const embed = body.embeds?.[0];

    assert.equal(embed?.title, "💼 Marketplace Business Logged");
    assert.equal(embed?.color, 0xf1c40f);
    assert.equal(embed?.description, undefined);
    assert.deepEqual(embed?.footer, { text: "hafbot.xyz" });
    assert.equal(embed?.timestamp, new Date(baseNow).toISOString());
    assert.deepEqual(embed?.fields, [
      { name: "Interested user", value: "<@buyer-1>\nID: buyer-1", inline: false },
      { name: "Post owner", value: "<@owner-1>\nID: owner-1", inline: false },
      { name: "Server", value: "Namalsk", inline: false },
      { name: "Post ID", value: "post-1", inline: false },
      { name: "DM sent", value: "Yes", inline: false },
      { name: "Have", value: "M4A1", inline: false },
      { name: "Looking for", value: "NVGs", inline: false },
    ]);
  } finally {
    Date.now = originalDateNow;
  }
});

function createConfig(): MarketplaceConfig {
  return {
    guildId: "guild-1",
    noticeChannelId: "channel-1",
    noticeMessageId: null,
    logChannelId: "log-channel-1",
    serverOptions: [
      { id: "namalsk", label: "Namalsk", emoji: "🧊" },
      { id: "chernarus", label: "Chernarus", emoji: "🌲" },
    ],
    updatedAtMs: 1,
  };
}

function createPost(): MarketplacePost {
  return {
    guildId: "guild-1",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    tradeType: "have",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    have: "M4A1",
    want: "NVGs",
    extra: "Safe zone",
    channelId: "channel-1",
    messageId: "message-1",
    active: true,
    createdAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
  };
}

function createStore() {
  const config = createConfig();
  const posts: MarketplacePost[] = [];
  const logs: MarketplaceBusinessLog[] = [];

  return {
    config,
    posts,
    logs,
    async readMarketplaceConfig() {
      return config;
    },
    async upsertMarketplaceConfig(nextConfig: MarketplaceConfig) {
      Object.assign(config, nextConfig);
    },
    async refreshMarketplaceNotice(
      input: Parameters<MarketplaceStore["refreshMarketplaceNotice"]>[0],
    ) {
      if (
        config.guildId !== input.guildId ||
        config.noticeChannelId !== input.channelId ||
        config.noticeMessageId !== input.previousMessageId ||
        config.updatedAtMs !== input.expectedUpdatedAtMs
      )
        return false;
      Object.assign(config, { noticeMessageId: input.messageId, updatedAtMs: input.updatedAtMs });
      return true;
    },
    async listMarketplacePosts() {
      return posts;
    },
    async readMarketplacePost(_guildId: string, postId: string) {
      return posts.find((post) => post.id === postId) ?? null;
    },
    async readActiveMarketplacePostByOwner(_guildId: string, ownerId: string) {
      return posts.find((post) => post.ownerId === ownerId && post.active) ?? null;
    },
    async createMarketplacePost(post: MarketplacePost) {
      posts.push(post);
    },
    async updateMarketplacePostMessage(body: { postId: string; messageId: string }) {
      const post = posts.find((entry) => entry.id === body.postId);
      if (post) post.messageId = body.messageId;
    },
    async closeMarketplacePost(body: {
      postId: string;
      closedByUserId: string;
      closedAtMs: number;
    }) {
      const post = posts.find((entry) => entry.id === body.postId);
      if (!post) throw new Error("missing post");
      post.active = false;
      post.closedByUserId = body.closedByUserId;
      post.closedAtMs = body.closedAtMs;
      return post;
    },
    async listMarketplaceLogs() {
      return logs;
    },
    async createMarketplaceLog(log: MarketplaceBusinessLog) {
      logs.push(log);
    },
  };
}
