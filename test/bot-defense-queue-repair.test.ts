/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  repairStrandedBotFlagQueueMessages,
  type BotDefenseQueueRepairStore,
} from "../src/services/bot-defense/queue-repair";
import type { BotDefenseConfig, BotFlag } from "../src/types";

const SIGNING_SECRET = "unit-test-signing-secret-0123456789abcdef";
const QUEUE_CHANNEL_ID = "queue-channel-1";
const DISCORD_MESSAGES_URL = /\/channels\/([^/]+)\/messages$/;

function createConfig(overrides: Partial<BotDefenseConfig> = {}): BotDefenseConfig {
  return {
    guildId: "guild-1",
    honeypotEnabled: true,
    honeypotWarnUser: false,
    honeypotDeleteMessage: false,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: ["channel-1"],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: ["mod-role-1"],
    modQueueChannelId: QUEUE_CHANNEL_ID,
    pingOnQueuePost: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  };
}

function createFlag(overrides: Partial<BotFlag> = {}): BotFlag {
  return {
    guildId: "guild-1",
    userId: "user-1",
    status: "open",
    detectorType: "honeypot",
    evidence: { kind: "honeypot", channelId: "channel-1", messageId: "msg-1" },
    queueMessageId: null,
    resolvedByDiscordUserId: null,
    resolvedAtMs: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

interface CapturedPost {
  channelId: string;
  authorization: string;
  body: {
    content?: string;
    nonce?: string;
    enforce_nonce?: boolean;
    embeds?: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
    components?: Array<{ components?: Array<{ label?: string; custom_id?: string }> }>;
  };
}

function createHarness(config: BotDefenseConfig | null) {
  const posts: CapturedPost[] = [];
  const resolvedQueueMessages: Array<{
    guildId: string;
    userId: string;
    expectedCreatedAtMs: number;
    queueMessageId: string;
  }> = [];
  let strandedFlags: BotFlag[] = [];
  const failingGuildIds = new Set<string>();

  const store: BotDefenseQueueRepairStore = {
    async listOpenBotFlagsMissingQueueMessage(nowMs, graceMs, limit) {
      assert.equal(nowMs, 10000);
      assert.equal(graceMs, 60000);
      assert.equal(limit, 25);
      return strandedFlags;
    },
    async readConfig(guildId) {
      if (failingGuildIds.has(guildId)) throw new Error("config read failed");
      if (!config || config.guildId !== guildId) return null;
      return config;
    },
    async setBotFlagQueueMessage(guildId, userId, expectedCreatedAtMs, queueMessageId) {
      resolvedQueueMessages.push({ guildId, userId, expectedCreatedAtMs, queueMessageId });
    },
  };

  async function fetchImpl(url: unknown, init?: RequestInit): Promise<Response> {
    const match = DISCORD_MESSAGES_URL.exec(String(url));
    assert.ok(match, `unexpected fetch url ${String(url)}`);
    posts.push({
      channelId: match[1],
      authorization: String(new Headers(init?.headers).get("Authorization")),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ id: `queue-message-${posts.length}` }), { status: 200 });
  }

  return {
    store,
    posts,
    resolvedQueueMessages,
    fetchImpl,
    setStrandedFlags(flags: BotFlag[]) {
      strandedFlags = flags;
    },
    failConfigReadsFor(guildId: string) {
      failingGuildIds.add(guildId);
    },
    resolveBotToken: async (guildId: string) => `token-for-${guildId}`,
  };
}

async function runRepair(harness: ReturnType<typeof createHarness>, signingSecret?: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetchImpl as typeof fetch;
  try {
    return await repairStrandedBotFlagQueueMessages({
      store: harness.store,
      resolveBotToken: harness.resolveBotToken,
      componentIdSigningSecret: signingSecret,
      graceMs: 60000,
      limit: 25,
      nowMs: () => 10000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("repair re-posts stranded flags and records the delivered queue message", async () => {
  const harness = createHarness(createConfig());
  harness.setStrandedFlags([
    createFlag(),
    createFlag({
      userId: "user-2",
      detectorType: "rate",
      evidence: {
        kind: "rate",
        channelIds: ["channel-2", "channel-3"],
        channelCount: 2,
        windowSeconds: 60,
        messageId: "msg-2",
        messageChannelId: "channel-2",
        messagePreview: "free crypto",
      },
    }),
  ]);

  const repaired = await runRepair(harness, SIGNING_SECRET);

  assert.equal(repaired, 2);
  assert.equal(harness.posts.length, 2);

  const first = harness.posts[0]!;
  assert.equal(first.channelId, QUEUE_CHANNEL_ID);
  assert.equal(first.authorization, "Bot token-for-guild-1");
  assert.equal(first.body.embeds?.[0]?.title, "Bot Defense Flag");
  assert.match(first.body.nonce ?? "", /^g:[A-Za-z0-9_-]{22}$/);
  assert.equal(first.body.enforce_nonce, true);
  const firstButtons = first.body.components?.[0]?.components ?? [];
  assert.deepEqual(
    firstButtons.map((button) => button.label),
    ["Confirm Bot", "Dismiss"],
  );
  for (const button of firstButtons) {
    assert.match(button.custom_id ?? "", /^1[cd]\./);
  }
  assert.deepEqual(harness.resolvedQueueMessages[0], {
    guildId: "guild-1",
    userId: "user-1",
    expectedCreatedAtMs: 1000,
    queueMessageId: "queue-message-1",
  });

  const second = harness.posts[1]!;
  assert.notEqual(second.body.nonce, first.body.nonce);
  const fieldNames = second.body.embeds?.[0]?.fields?.map((field) => field.name) ?? [];
  assert.ok(fieldNames.includes("Matching Channels"));
  assert.deepEqual(harness.resolvedQueueMessages[1], {
    guildId: "guild-1",
    userId: "user-2",
    expectedCreatedAtMs: 1000,
    queueMessageId: "queue-message-2",
  });
});

test("repair leaves unsigned component IDs when no signing secret is configured", async () => {
  const harness = createHarness(createConfig());
  harness.setStrandedFlags([createFlag()]);

  const repaired = await runRepair(harness);

  assert.equal(repaired, 1);
  const buttons = harness.posts[0]!.body.components?.[0]?.components ?? [];
  assert.deepEqual(
    buttons.map((button) => button.custom_id),
    ["bot-defense:confirm:guild-1:user-1:1000", "bot-defense:dismiss:guild-1:user-1:1000"],
  );
});

test("repair skips flags without a mod queue channel and continues past failures", async () => {
  const missingQueue = createHarness(null);
  missingQueue.setStrandedFlags([createFlag()]);

  assert.equal(await runRepair(missingQueue, SIGNING_SECRET), 0);
  assert.equal(missingQueue.posts.length, 0);
  assert.equal(missingQueue.resolvedQueueMessages.length, 0);

  const failing = createHarness(createConfig());
  failing.setStrandedFlags([createFlag(), createFlag({ userId: "user-2" })]);
  failing.failConfigReadsFor("guild-1");

  assert.equal(await runRepair(failing, SIGNING_SECRET), 0);
  assert.equal(failing.resolvedQueueMessages.length, 0);
});
