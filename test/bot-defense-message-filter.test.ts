/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  fingerprintRateMessage,
  moderateBotDefenseMessageCreate,
  type BotDefenseMessageFilterDependencies,
} from "../src/services/bot-defense/message-filter";
import type { BotDefenseConfig, DiscordMessageCreate } from "../src/types";
import type { Env } from "../src/env";
import { createCloudflareBotDefenseStore } from "../src/runtime/cloudflare-bot-defense-store";
import { fingerprintImageAttachments } from "../src/services/bot-defense/attachment-fingerprint";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { fixtureFetch, imageFixture } from "./support/bot-defense-image-fixtures";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "public-key",
    GATEWAY_SESSION_DO: {} as DurableObjectNamespace,
    GATEWAY_EVENT_QUEUE: {} as Queue<unknown>,
    HAF_DB: {} as D1Database,
    ...overrides,
  };
}

function createConfig(overrides: Partial<BotDefenseConfig> = {}): BotDefenseConfig {
  return {
    guildId: "guild-1",
    honeypotEnabled: false,
    honeypotWarnUser: false,
    honeypotDeleteMessage: false,
    rateEnabled: false,
    rateWarnUser: false,
    rateDeleteMessage: false,
    honeypotChannelIds: [],
    rateChannelThreshold: 5,
    rateWindowSeconds: 60,
    excludedRoleIds: [],
    modRoleIds: [],
    modQueueChannelId: null,
    pingOnQueuePost: false,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

function createMessage(overrides: Partial<DiscordMessageCreate> = {}): DiscordMessageCreate {
  return {
    id: "message-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    content: "hello",
    author: { id: "user-1" },
    member: { roles: [] },
    ...overrides,
  };
}

function createDependencies(
  overrides: Partial<BotDefenseMessageFilterDependencies> = {},
): BotDefenseMessageFilterDependencies & {
  readConfigCalls: string[];
  rateEvents: Array<{
    guildId: string;
    userId: string;
    channelId: string;
    messageFingerprint: string;
    messageTimestampMs: number;
  }>;
  distinctChannelLists: Array<{
    guildId: string;
    userId: string;
    messageFingerprint: string;
    windowMs: number;
    nowMs: number;
  }>;
  openFlagCalls: Array<{
    guildId: string;
    userId: string;
    detectorType: string;
    evidence: unknown;
  }>;
  queueMessages: Array<{ channelId: string; body: unknown }>;
  auditEvents: Array<{ eventId: string; guildId: string; channelId: string; messageId?: string }>;
  resolvedFlags: Array<{
    guildId: string;
    userId: string;
    createdAtMs: number;
    queueMessageId: string;
    nowMs: number;
  }>;
  resolveChannelParentCalls: string[];
  warningMessages: Array<{ channelId: string; messageId: string; userId: string }>;
  deletedMessages: Array<{ channelId: string; messageId: string }>;
} {
  const readConfigCalls: string[] = [];
  const rateEvents: Array<{
    guildId: string;
    userId: string;
    channelId: string;
    messageFingerprint: string;
    messageTimestampMs: number;
  }> = [];
  const distinctChannelLists: Array<{
    guildId: string;
    userId: string;
    messageFingerprint: string;
    windowMs: number;
    nowMs: number;
  }> = [];
  const openFlagCalls: Array<{
    guildId: string;
    userId: string;
    detectorType: string;
    evidence: unknown;
  }> = [];
  const queueMessages: Array<{ channelId: string; body: unknown }> = [];
  const auditEvents: Array<{
    eventId: string;
    guildId: string;
    channelId: string;
    messageId?: string;
  }> = [];
  const resolvedFlags: Array<{
    guildId: string;
    userId: string;
    createdAtMs: number;
    queueMessageId: string;
    nowMs: number;
  }> = [];
  const resolveChannelParentCalls: string[] = [];
  const warningMessages: Array<{ channelId: string; messageId: string; userId: string }> = [];
  const deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  const openFlags = new Map<
    string,
    { guildId: string; userId: string; queueMessageId: string | null; createdAtMs: number }
  >();
  const confirmed = new Set<string>();

  return {
    fingerprintImageAttachments: overrides.fingerprintImageAttachments ?? (async () => null),
    readConfigCalls,
    rateEvents,
    distinctChannelLists,
    openFlagCalls,
    queueMessages,
    auditEvents,
    resolvedFlags,
    resolveChannelParentCalls,
    warningMessages,
    deletedMessages,
    readConfig: async (guildId) => {
      readConfigCalls.push(guildId);
      if (overrides.readConfig) return await overrides.readConfig(guildId);
      return createConfig();
    },
    readGuildEntitlement: async (guildId) => {
      if (overrides.readGuildEntitlement) return await overrides.readGuildEntitlement(guildId);
      return { guildId, tier: "premium", updatedAtMs: 0 };
    },
    resolveChannelParent: async (channelId, botToken) => {
      resolveChannelParentCalls.push(channelId);
      if (overrides.resolveChannelParent)
        return await overrides.resolveChannelParent(channelId, botToken);
      return { parentId: null, type: 0 };
    },
    openBotFlag: async (guildId, userId, detectorType, evidence) => {
      openFlagCalls.push({ guildId, userId, detectorType, evidence });
      if (overrides.openBotFlag)
        return await overrides.openBotFlag(guildId, userId, detectorType, evidence);
      const key = `${guildId}:${userId}`;
      if (openFlags.has(key) || confirmed.has(key)) return null;
      const flag = { guildId, userId, queueMessageId: null, createdAtMs: 10000 };
      openFlags.set(key, flag);
      return flag;
    },
    setBotFlagQueueMessage: async (guildId, userId, createdAtMs, queueMessageId, nowMs) => {
      resolvedFlags.push({ guildId, userId, createdAtMs, queueMessageId, nowMs });
      if (overrides.setBotFlagQueueMessage)
        return await overrides.setBotFlagQueueMessage(
          guildId,
          userId,
          createdAtMs,
          queueMessageId,
          nowMs,
        );
    },
    recordRateMessage: async (
      guildId,
      userId,
      channelId,
      messageFingerprint,
      messageTimestampMs,
    ) => {
      if (overrides.recordRateMessage)
        return await overrides.recordRateMessage(
          guildId,
          userId,
          channelId,
          messageFingerprint,
          messageTimestampMs,
        );
      rateEvents.push({ guildId, userId, channelId, messageFingerprint, messageTimestampMs });
    },
    listMatchingMessageChannelsInWindow: async (
      guildId,
      userId,
      messageFingerprint,
      windowMs,
      nowMs,
    ) => {
      distinctChannelLists.push({ guildId, userId, messageFingerprint, windowMs, nowMs });
      if (overrides.listMatchingMessageChannelsInWindow) {
        return await overrides.listMatchingMessageChannelsInWindow(
          guildId,
          userId,
          messageFingerprint,
          windowMs,
          nowMs,
        );
      }
      return ["channel-1"];
    },
    createChannelMessage: async (channelId, body, botToken) => {
      queueMessages.push({ channelId, body });
      if (overrides.createChannelMessage)
        return await overrides.createChannelMessage(channelId, body, botToken);
      return { id: "queue-message-1" };
    },
    warnUser: async (channelId, messageId, userId, detectorType) => {
      warningMessages.push({ channelId, messageId, userId });
      if (overrides.warnUser)
        return await overrides.warnUser(channelId, messageId, userId, detectorType);
    },
    deleteMessage: async (channelId, messageId) => {
      deletedMessages.push({ channelId, messageId });
      if (overrides.deleteMessage) return await overrides.deleteMessage(channelId, messageId);
    },
    postAuditEvent: async (eventId, data) => {
      auditEvents.push({
        eventId,
        guildId: data.guildId,
        channelId: data.channelId,
        messageId: data.messageId,
      });
      if (overrides.postAuditEvent) return await overrides.postAuditEvent(eventId, data);
    },
    resolveBotDisplayName: async (guildId) => {
      if (overrides.resolveBotDisplayName) return await overrides.resolveBotDisplayName(guildId);
      return "HAF Bot";
    },
    nowMs: () => {
      if (overrides.nowMs) return overrides.nowMs();
      return 10000;
    },
  };
}

test("moderateBotDefenseMessageCreate does nothing when HAF_DB is missing", async () => {
  const dependencies = createDependencies();
  await moderateBotDefenseMessageCreate(
    createMessage(),
    createEnv({ HAF_DB: undefined }),
    dependencies,
  );
  assert.deepEqual(dependencies.readConfigCalls, []);
});

test("moderateBotDefenseMessageCreate does nothing for non-guild messages", async () => {
  const dependencies = createDependencies();
  await moderateBotDefenseMessageCreate(
    createMessage({ guild_id: undefined }),
    createEnv(),
    dependencies,
  );
  assert.deepEqual(dependencies.readConfigCalls, []);
});

test("moderateBotDefenseMessageCreate reads entitlement and config concurrently", async () => {
  let activeReads = 0;
  let maxActiveReads = 0;
  const delayed = async <T>(value: T): Promise<T> => {
    activeReads += 1;
    maxActiveReads = Math.max(maxActiveReads, activeReads);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    activeReads -= 1;
    return value;
  };
  const dependencies = createDependencies({
    readConfig: async () => delayed(createConfig()),
    readGuildEntitlement: async (guildId) => delayed({ guildId, tier: "premium", updatedAtMs: 0 }),
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.equal(maxActiveReads, 2);
});

test("Bot Defense keeps configuration read failures non-retryable", async () => {
  const dependencies = createDependencies({
    readConfig: async () => {
      throw new Error("config unavailable");
    },
  });

  await assert.doesNotReject(
    moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies),
  );
  assert.deepEqual(dependencies.openFlagCalls, []);
  assert.deepEqual(dependencies.rateEvents, []);
});

test("Bot Defense keeps entitlement failures retryable", async () => {
  const dependencies = createDependencies({
    readGuildEntitlement: async () => {
      throw new Error("entitlement unavailable");
    },
  });

  await assert.rejects(
    moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies),
    /entitlement unavailable/,
  );
});

test("moderateBotDefenseMessageCreate reads all-plan Bot Defense config for free-tier Guilds", async () => {
  const dependencies = createDependencies({
    readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.readConfigCalls, ["guild-1"]);
  assert.deepEqual(dependencies.rateEvents, []);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("Free runs Honeypot Detector without recording dormant Rate Detector messages", async () => {
  const dependencies = createDependencies({
    readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        rateEnabled: true,
        rateChannelThreshold: 2,
      }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.equal(dependencies.openFlagCalls[0]?.detectorType, "honeypot");
  assert.deepEqual(dependencies.rateEvents, []);
  assert.deepEqual(dependencies.distinctChannelLists, []);
});

test("moderateBotDefenseMessageCreate does nothing when both detectors are disabled", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ honeypotEnabled: false, rateEnabled: false }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("moderateBotDefenseMessageCreate skips bot authors", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true }),
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ author: { id: "bot-1", bot: true } }),
    createEnv(),
    dependencies,
  );
  assert.deepEqual(dependencies.rateEvents, []);
});

test("moderateBotDefenseMessageCreate skips webhook-authored messages", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true }),
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ author: { id: "webhook-1" }, webhook_id: "webhook-token-1" }),
    createEnv(),
    dependencies,
  );
  assert.deepEqual(dependencies.rateEvents, []);
});

test("moderateBotDefenseMessageCreate skips excluded-role holders", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true, excludedRoleIds: ["role-1"] }),
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ member: { roles: ["role-1"] } }),
    createEnv(),
    dependencies,
  );
  assert.deepEqual(dependencies.rateEvents, []);
});

test("honeypot detector raises a flag in a target channel", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({ honeypotEnabled: true, honeypotChannelIds: ["channel-1"] }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.equal(dependencies.openFlagCalls[0]?.detectorType, "honeypot");
  assert.equal(dependencies.auditEvents[0]?.eventId, "bot-defense.honeypot-trip");
  assert.equal(dependencies.queueMessages.length, 0);
});

test("honeypot detector can warn and delete independently", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotWarnUser: true,
        honeypotDeleteMessage: false,
      }),
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.warningMessages, [
    { channelId: "channel-1", messageId: "message-1", userId: "user-1" },
  ]);
  assert.deepEqual(dependencies.deletedMessages, []);
});

test("honeypot deletion still runs when its warning fails", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotWarnUser: true,
        honeypotDeleteMessage: true,
      }),
    warnUser: async () => {
      throw new Error("warning failed");
    },
  });

  await assert.rejects(
    moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies),
    /deferred for retry/,
  );

  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
});

test("honeypot permanent warning failures do not retry the gateway event", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotWarnUser: true,
        honeypotDeleteMessage: true,
      }),
    warnUser: async () => {
      throw Object.assign(new Error("missing permissions"), { status: 403 });
    },
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
});

test("honeypot actions still run while an existing flag suppresses a new flag", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotWarnUser: true,
      }),
    openBotFlag: async () => null,
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.deepEqual(dependencies.warningMessages, [
    { channelId: "channel-1", messageId: "message-1", userId: "user-1" },
  ]);
});

test("honeypot and rate actions both run when one message trips both detectors", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotWarnUser: true,
        rateEnabled: true,
        rateDeleteMessage: true,
        rateChannelThreshold: 2,
      }),
    listMatchingMessageChannelsInWindow: async () => ["channel-1", "channel-2"],
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.warningMessages, [
    { channelId: "channel-1", messageId: "message-1", userId: "user-1" },
  ]);
  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
});

test("honeypot detector posts to the mod queue when configured", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        modQueueChannelId: "queue-channel-1",
        modRoleIds: ["mod-role-1"],
        pingOnQueuePost: true,
      }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.equal(dependencies.queueMessages.length, 1);
  assert.equal(dependencies.queueMessages[0]?.channelId, "queue-channel-1");
  const components = (
    dependencies.queueMessages[0]?.body as {
      components?: Array<{ components?: Array<{ custom_id?: string }> }>;
    }
  ).components;
  assert.equal(
    components?.[0]?.components?.[0]?.custom_id,
    "bot-defense:confirm:guild-1:user-1:10000",
  );
  assert.equal(
    components?.[0]?.components?.[1]?.custom_id,
    "bot-defense:dismiss:guild-1:user-1:10000",
  );
});

test("honeypot detector does not raise a flag outside target channels", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({ honeypotEnabled: true, honeypotChannelIds: ["other-channel"] }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("honeypot detector trips in threads under a target channel", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({ honeypotEnabled: true, honeypotChannelIds: ["parent-1"] }),
    resolveChannelParent: async () => ({ parentId: "parent-1", type: 11 }),
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ channel_id: "thread-1" }),
    createEnv(),
    dependencies,
  );
  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.equal(dependencies.resolveChannelParentCalls[0], "thread-1");
});

test("honeypot detector ignores forum posts under a target channel", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({ honeypotEnabled: true, honeypotChannelIds: ["parent-1"] }),
    resolveChannelParent: async (channelId) =>
      channelId === "forum-post-1"
        ? { parentId: "parent-1", type: 11 }
        : { parentId: null, type: 15 },
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ channel_id: "forum-post-1" }),
    createEnv(),
    dependencies,
  );
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("honeypot detector does nothing when target list is empty", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ honeypotEnabled: true, honeypotChannelIds: [] }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("rate detector raises a flag at threshold", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true, rateChannelThreshold: 5 }),
    listMatchingMessageChannelsInWindow: async () => [
      "channel-1",
      "channel-2",
      "channel-3",
      "channel-4",
      "channel-5",
    ],
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.equal(dependencies.openFlagCalls[0]?.detectorType, "rate");
  assert.deepEqual(
    (dependencies.openFlagCalls[0]?.evidence as { channelIds: string[] } | undefined)?.channelIds,
    ["channel-1", "channel-2", "channel-3", "channel-4", "channel-5"],
  );
  assert.equal(
    (dependencies.openFlagCalls[0]?.evidence as { messagePreview: string } | undefined)
      ?.messagePreview,
    "hello",
  );
  assert.equal(
    dependencies.rateEvents[0]?.messageFingerprint,
    await fingerprintRateMessage("hello"),
  );
  assert.equal(dependencies.auditEvents[0]?.eventId, "bot-defense.rate-trip");
});

test("rate detector can delete without warning independently of honeypot actions", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        honeypotWarnUser: true,
        honeypotDeleteMessage: false,
        rateEnabled: true,
        rateWarnUser: false,
        rateDeleteMessage: true,
        rateChannelThreshold: 2,
      }),
    listMatchingMessageChannelsInWindow: async () => ["channel-1", "channel-2"],
  });

  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.warningMessages, []);
  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
});

test("rate message fingerprints ignore case, Unicode width, and repeated whitespace", async () => {
  const first = await fingerprintRateMessage("  FREE   Crypto Offer  ");
  const second = await fingerprintRateMessage("ｆｒｅｅ crypto offer");
  const different = await fingerprintRateMessage("free crypto giveaway");

  assert.equal(first, second);
  assert.notEqual(first, different);
});

test("rate detector ignores messages without text content", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true }),
  });

  await moderateBotDefenseMessageCreate(
    createMessage({ content: "   " }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.rateEvents, []);
  assert.deepEqual(dependencies.distinctChannelLists, []);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

function imageReplay(config: Partial<BotDefenseConfig> = {}) {
  const database = new SqliteD1Database();
  const store = createCloudflareBotDefenseStore(database as unknown as D1Database);
  const fixtures = Array.from({ length: 8 }, (_, upload) =>
    Array.from({ length: 4 }, (_, index) => imageFixture(index, upload + 1)),
  ).flat();
  let now = 10000;
  let downloads = 0;
  const fetcher = fixtureFetch(fixtures);
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true, ...config }),
    nowMs: () => now,
    fingerprintImageAttachments: (attachments) =>
      fingerprintImageAttachments(attachments, (async (input, init) => {
        downloads += 1;
        return fetcher(input, init);
      }) as typeof fetch),
    recordRateMessage: (...args) => store.recordRateMessage(...args),
    listMatchingMessageChannelsInWindow: (...args) =>
      store.listMatchingMessageChannelsInWindow(...args),
    openBotFlag: (...args) => store.openBotFlag(...args),
  });
  return {
    database,
    dependencies,
    downloads: () => downloads,
    setNow: (value: number) => {
      now = value;
    },
    message: (channel: number, count = 4, overrides: Partial<DiscordMessageCreate> = {}) =>
      createMessage({
        id: `image-message-${channel}`,
        channel_id: `channel-${channel}`,
        content: channel % 2 === 0 ? " \n " : "",
        attachments: fixtures
          .filter((f) => f.attachment.filename.startsWith(`harmless-tile-${channel}-`))
          .slice(0, count)
          .map((f) => f.attachment)
          .reverse(),
        ...overrides,
      }),
  };
}

for (const count of [1, 2, 3, 4]) {
  test(`attachment-only replay with ${count} image(s) trips at five distinct channels, not before`, async (t) => {
    const replay = imageReplay({ modQueueChannelId: "staff-queue", rateDeleteMessage: true });
    t.after(() => replay.database.close());
    for (let channel = 1; channel <= 4; channel += 1) {
      await moderateBotDefenseMessageCreate(
        replay.message(channel, count),
        createEnv(),
        replay.dependencies,
      );
    }
    assert.equal(replay.dependencies.openFlagCalls.length, 0);
    assert.equal(replay.dependencies.deletedMessages.length, 0);
    await moderateBotDefenseMessageCreate(
      replay.message(5, count),
      createEnv(),
      replay.dependencies,
    );
    assert.equal(replay.dependencies.openFlagCalls.length, 1);
    assert.deepEqual(replay.dependencies.deletedMessages, [
      { channelId: "channel-5", messageId: "image-message-5" },
    ]);
    assert.equal(replay.downloads(), count * 5);
    assert.deepEqual(replay.dependencies.warningMessages, []);
    const evidence = replay.dependencies.openFlagCalls[0].evidence as {
      matchKind: string;
      attachmentCount: number;
      channelCount: number;
    };
    assert.equal(evidence.matchKind, "image-attachments");
    assert.equal(evidence.attachmentCount, count);
    assert.equal(evidence.channelCount, 5);
    assert.match(JSON.stringify(replay.dependencies.queueMessages), /Repeated Images/);
    assert.doesNotMatch(
      JSON.stringify(replay.dependencies.queueMessages),
      /cdn\.discordapp|harmless-tile/,
    );
    await moderateBotDefenseMessageCreate(
      replay.message(6, count),
      createEnv(),
      replay.dependencies,
    );
    assert.equal(replay.dependencies.queueMessages.length, 1);
    assert.equal(replay.dependencies.deletedMessages.length, 2);
  });
}

test("image replay preserves single-album, single-channel, author and Guild boundaries", async (t) => {
  const replay = imageReplay();
  t.after(() => replay.database.close());
  for (let i = 1; i <= 5; i += 1) {
    await moderateBotDefenseMessageCreate(replay.message(1), createEnv(), replay.dependencies);
    await moderateBotDefenseMessageCreate(
      replay.message(i, 4, { author: { id: `different-user-${i}` } }),
      createEnv(),
      replay.dependencies,
    );
    await moderateBotDefenseMessageCreate(
      replay.message(i, 4, { guild_id: `different-guild-${i}` }),
      createEnv(),
      replay.dependencies,
    );
  }
  assert.deepEqual(replay.dependencies.openFlagCalls, []);
  assert.deepEqual(replay.dependencies.deletedMessages, []);
});

test("image replay expires earlier channels and does not count a new set with missing images", async (t) => {
  const replay = imageReplay();
  t.after(() => replay.database.close());
  for (let channel = 1; channel <= 4; channel += 1) {
    await moderateBotDefenseMessageCreate(
      replay.message(channel),
      createEnv(),
      replay.dependencies,
    );
  }
  await moderateBotDefenseMessageCreate(replay.message(5, 3), createEnv(), replay.dependencies);
  assert.equal(replay.dependencies.openFlagCalls.length, 0);
  replay.setNow(70001);
  await moderateBotDefenseMessageCreate(replay.message(6), createEnv(), replay.dependencies);
  assert.equal(replay.dependencies.openFlagCalls.length, 0);
});

test("images are not downloaded for captions, mention-only content, exclusions or dormant detectors", async (t) => {
  const replay = imageReplay({ excludedRoleIds: ["trusted"] });
  t.after(() => replay.database.close());
  for (const content of ["ordinary caption", "<@123>", "@everyone"]) {
    await moderateBotDefenseMessageCreate(
      replay.message(1, 4, { content }),
      createEnv(),
      replay.dependencies,
    );
  }
  await moderateBotDefenseMessageCreate(
    replay.message(2, 4, { member: { roles: ["trusted"] } }),
    createEnv(),
    replay.dependencies,
  );
  await moderateBotDefenseMessageCreate(
    replay.message(3, 4, { author: { id: "bot", bot: true } }),
    createEnv(),
    replay.dependencies,
  );
  await moderateBotDefenseMessageCreate(
    replay.message(4, 4, { webhook_id: "webhook" }),
    createEnv(),
    replay.dependencies,
  );
  await moderateBotDefenseMessageCreate(replay.message(5), createEnv(), {
    ...replay.dependencies,
    readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
  });
  await moderateBotDefenseMessageCreate(replay.message(6), createEnv(), {
    ...replay.dependencies,
    readConfig: async () => createConfig({ rateEnabled: false }),
  });
  assert.equal(replay.downloads(), 0);
  assert.equal(replay.dependencies.openFlagCalls.length, 0);
});

test("failed image comparison leaves Rate Detector silent and Honeypot actions intact", async () => {
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({
        rateEnabled: true,
        honeypotEnabled: true,
        honeypotChannelIds: ["channel-1"],
        honeypotDeleteMessage: true,
        rateDeleteMessage: true,
      }),
    fingerprintImageAttachments: async () => null,
  });
  await moderateBotDefenseMessageCreate(
    createMessage({ content: "", attachments: [imageFixture().attachment] }),
    createEnv(),
    dependencies,
  );
  assert.equal(dependencies.rateEvents.length, 0);
  assert.equal(dependencies.openFlagCalls[0]?.detectorType, "honeypot");
  assert.equal(dependencies.openFlagCalls.length, 1);
  assert.equal(dependencies.deletedMessages.length, 1);
});

test("delayed and future Gateway image messages skip downloads and enforcement", async (t) => {
  const replay = imageReplay({ rateChannelThreshold: 2, rateDeleteMessage: true });
  t.after(() => replay.database.close());
  const now = 1791234000000;
  replay.setNow(now);
  for (const timestamp of [now - 60001, now + 1000]) {
    const id = String(BigInt(timestamp - 1420070400000) << 22n);
    await moderateBotDefenseMessageCreate(
      replay.message(1, 4, { id }),
      createEnv(),
      replay.dependencies,
    );
  }
  assert.equal(replay.downloads(), 0);
  assert.equal(replay.dependencies.deletedMessages.length, 0);
});

test("concurrent image messages at threshold open only one review item", async (t) => {
  const replay = imageReplay({ rateChannelThreshold: 2, modQueueChannelId: "staff-queue" });
  t.after(() => replay.database.close());
  await Promise.all(
    [1, 2, 3, 4].map((channel) =>
      moderateBotDefenseMessageCreate(replay.message(channel), createEnv(), replay.dependencies),
    ),
  );
  assert.equal(replay.dependencies.queueMessages.length, 1);
  assert.equal(replay.dependencies.deletedMessages.length, 0);
});

for (const threshold of [2, 5]) {
  test(`later image download finishing first still trips the ${threshold}-channel threshold`, async (t) => {
    const replay = imageReplay({
      rateChannelThreshold: threshold,
      modQueueChannelId: "staff-queue",
      rateDeleteMessage: true,
    });
    t.after(() => replay.database.close());
    const earlierTime = 1791234000000;
    const messageAt = (channel: number, timestamp: number) =>
      replay.message(channel, 4, {
        id: String((BigInt(timestamp - 1420070400000) << 22n) + BigInt(channel)),
      });
    for (let channel = 1; channel < threshold - 1; channel += 1) {
      replay.setNow(earlierTime - 200);
      await moderateBotDefenseMessageCreate(
        messageAt(channel, earlierTime - 200),
        createEnv(),
        replay.dependencies,
      );
    }
    let releaseEarlier!: () => void;
    let announceEarlier!: () => void;
    const earlierStarted = new Promise<void>((resolve) => {
      announceEarlier = resolve;
    });
    const earlierDownload = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    const recordedTimes: number[] = [];
    const dependencies = {
      ...replay.dependencies,
      fingerprintImageAttachments: async (attachments: unknown[]) => {
        const first = attachments[0] as { filename: string };
        if (first.filename.startsWith(`harmless-tile-${threshold - 1}-`)) {
          announceEarlier();
          await earlierDownload;
        }
        return replay.dependencies.fingerprintImageAttachments(attachments);
      },
      recordRateMessage: async (
        ...args: Parameters<typeof replay.dependencies.recordRateMessage>
      ) => {
        recordedTimes.push(args[4]);
        await replay.dependencies.recordRateMessage(...args);
      },
    };
    replay.setNow(earlierTime);
    const earlier = moderateBotDefenseMessageCreate(
      messageAt(threshold - 1, earlierTime),
      createEnv(),
      dependencies,
    );
    await earlierStarted;
    replay.setNow(earlierTime + 100);
    await moderateBotDefenseMessageCreate(
      messageAt(threshold, earlierTime + 100),
      createEnv(),
      dependencies,
    );
    assert.equal(replay.dependencies.queueMessages.length, 0);
    replay.setNow(earlierTime + 200);
    releaseEarlier();
    await earlier;
    assert.deepEqual(recordedTimes, [earlierTime + 100, earlierTime]);
    assert.equal(replay.dependencies.queueMessages.length, 1);
    assert.equal(replay.dependencies.distinctChannelLists.at(-1)?.nowMs, earlierTime + 200);
    const evidence = replay.dependencies.openFlagCalls[0]?.evidence as { channelCount: number };
    assert.equal(evidence.channelCount, threshold);
    assert.deepEqual(replay.dependencies.deletedMessages, [
      {
        channelId: `channel-${threshold - 1}`,
        messageId: messageAt(threshold - 1, earlierTime).id,
      },
    ]);
  });
}

test("image message aging out during fingerprinting skips persistence and actions", async (t) => {
  const replay = imageReplay({ rateChannelThreshold: 1, rateDeleteMessage: true });
  t.after(() => replay.database.close());
  const timestamp = 1791234000000;
  replay.setNow(timestamp);
  await moderateBotDefenseMessageCreate(
    replay.message(1, 4, { id: String(BigInt(timestamp - 1420070400000) << 22n) }),
    createEnv(),
    {
      ...replay.dependencies,
      fingerprintImageAttachments: async (attachments) => {
        const fingerprint = await replay.dependencies.fingerprintImageAttachments(attachments);
        replay.setNow(timestamp + 60001);
        return fingerprint;
      },
    },
  );
  assert.deepEqual(replay.database.query("SELECT * FROM bot_defense_rate_window_events"), []);
  assert.equal(replay.dependencies.openFlagCalls.length, 0);
  assert.equal(replay.dependencies.deletedMessages.length, 0);
});

test("rate evaluation rechecks freshness after persistence without changing event time", async (t) => {
  const replay = imageReplay({ rateChannelThreshold: 1, rateDeleteMessage: true });
  t.after(() => replay.database.close());
  const timestamp = 1791234000000;
  replay.setNow(timestamp);
  await moderateBotDefenseMessageCreate(
    replay.message(1, 4, { id: String(BigInt(timestamp - 1420070400000) << 22n) }),
    createEnv(),
    {
      ...replay.dependencies,
      recordRateMessage: async (...args) => {
        await replay.dependencies.recordRateMessage(...args);
        replay.setNow(timestamp + 60001);
      },
    },
  );
  assert.deepEqual(
    replay.database.query("SELECT message_timestamp_ms FROM bot_defense_rate_window_events"),
    [{ message_timestamp_ms: timestamp }],
  );
  assert.equal(replay.dependencies.distinctChannelLists.length, 0);
  assert.equal(replay.dependencies.openFlagCalls.length, 0);
  assert.equal(replay.dependencies.deletedMessages.length, 0);
});

for (const contentKind of ["image", "text"] as const) {
  for (const ageAfterLookup of [60000, 60001]) {
    test(`${contentKind} Rate message at age ${ageAfterLookup}ms after channel lookup only acts within its window`, async (t) => {
      const replay = imageReplay({
        rateChannelThreshold: 2,
        rateWarnUser: true,
        rateDeleteMessage: true,
        modQueueChannelId: "staff-queue",
      });
      t.after(() => replay.database.close());
      const store = createCloudflareBotDefenseStore(replay.database.d1);
      const timestamp = 1791234000000;
      const messageAt = (channel: number) =>
        replay.message(channel, 1, {
          id: String((BigInt(timestamp - 1420070400000) << 22n) + BigInt(channel)),
          ...(contentKind === "text" ? { content: "repeated text" } : {}),
        });
      replay.setNow(timestamp);
      await moderateBotDefenseMessageCreate(messageAt(1), createEnv(), replay.dependencies);
      replay.setNow(timestamp + 59999);
      await moderateBotDefenseMessageCreate(messageAt(2), createEnv(), {
        ...replay.dependencies,
        listMatchingMessageChannelsInWindow: async (...args) => {
          const channels = await replay.dependencies.listMatchingMessageChannelsInWindow(...args);
          assert.equal(args[4], timestamp + 59999);
          assert.deepEqual([...channels].sort(), ["channel-1", "channel-2"]);
          replay.setNow(timestamp + ageAfterLookup);
          return channels;
        },
      });

      assert.deepEqual(
        replay.database.query(
          "SELECT message_timestamp_ms FROM bot_defense_rate_window_events ORDER BY channel_id",
        ),
        [{ message_timestamp_ms: timestamp }, { message_timestamp_ms: timestamp }],
      );
      const expectedActions = ageAfterLookup === 60000 ? 1 : 0;
      assert.deepEqual(
        {
          warnings: replay.dependencies.warningMessages.length,
          deletions: replay.dependencies.deletedMessages.length,
          flags: replay.dependencies.openFlagCalls.length,
          queueMessages: replay.dependencies.queueMessages.length,
          queueUpdates: replay.dependencies.resolvedFlags.length,
          auditEvents: replay.dependencies.auditEvents.length,
        },
        {
          warnings: expectedActions,
          deletions: expectedActions,
          flags: expectedActions,
          queueMessages: expectedActions,
          queueUpdates: expectedActions,
          auditEvents: expectedActions,
        },
      );
      assert.equal(
        (await store.readOpenBotFlag("guild-1", "user-1"))?.status ?? null,
        expectedActions ? "open" : null,
      );
    });
  }
}

test("rate detector does not raise a flag below threshold", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true, rateChannelThreshold: 5 }),
    listMatchingMessageChannelsInWindow: async () => [
      "channel-1",
      "channel-2",
      "channel-3",
      "channel-4",
    ],
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.openFlagCalls, []);
});

test("rate detector records the message before counting", async () => {
  let recorded = false;
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true }),
    recordRateMessage: async (...args) => {
      recorded = true;
      return createDependencies().recordRateMessage(...args);
    },
    listMatchingMessageChannelsInWindow: async () => {
      assert.equal(recorded, true);
      return ["channel-1", "channel-2", "channel-3", "channel-4", "channel-5"];
    },
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.equal(dependencies.openFlagCalls.length, 1);
});

test("one-open flag per member suppresses additional flags", async () => {
  let openCount = 0;
  const dependencies = createDependencies({
    readConfig: async () =>
      createConfig({ honeypotEnabled: true, honeypotChannelIds: ["channel-1"] }),
    openBotFlag: async (...args) => {
      openCount += 1;
      if (openCount > 1) return null;
      return { guildId: args[0], userId: args[1], queueMessageId: null, createdAtMs: 10000 };
    },
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  await moderateBotDefenseMessageCreate(
    createMessage({ id: "message-2" }),
    createEnv(),
    dependencies,
  );
  assert.equal(dependencies.openFlagCalls.length, 2);
  assert.equal(dependencies.queueMessages.length, 0);
});

test("dormancy skips work when guild is below premium tier", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ rateEnabled: true }),
    readGuildEntitlement: async (guildId) => ({ guildId, tier: "free", updatedAtMs: 0 }),
  });
  await moderateBotDefenseMessageCreate(createMessage(), createEnv(), dependencies);
  assert.deepEqual(dependencies.rateEvents, []);
});
