/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  moderateImageRulesMessageCreate,
  type ImageRulesMessageFilterDependencies,
} from "../src/services/image-rules/message-filter";
import type { ImageRulesConfig, DiscordMessageCreate } from "../src/types";
import type { Env } from "./support/test-env";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: "public-key",
    GATEWAY_SESSION_DO: {} as DurableObjectNamespace,
    GATEWAY_EVENT_QUEUE: {} as Queue<unknown>,
    HAF_DB: {} as D1Database,
    IMAGE_RULES_API_BASE_URL: "https://api.example.com",
    IMAGE_RULES_API_KEY: "secret-key",
    ...overrides,
  };
}

function createConfig(overrides: Partial<ImageRulesConfig> = {}): ImageRulesConfig {
  return {
    guildId: "guild-1",
    enabled: true,
    topicDescription: "DayZ screenshots",
    autoDeleteThreshold: 0.85,
    modReviewThreshold: 0.65,
    targetChannelIds: [],
    excludedRoleIds: [],
    modQueueChannelId: null,
    modRoleIds: [],
    pingOnQueuePost: false,
    reactOnTopic: false,
    auditOnTopic: false,
    dryRun: false,
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
    content: "look at this",
    author: { id: "user-1" },
    member: { roles: [] },
    attachments: [
      {
        id: "attachment-1",
        url: "https://cdn.discordapp.com/attachments/1/1/image.png",
        content_type: "image/png",
        size: 1000,
        width: 512,
        height: 512,
      },
    ],
    ...overrides,
  };
}

function createClassification(
  overrides: Partial<{
    image_description: string;
    classification_reason: string;
    off_topic_confidence: number;
    on_topic_confidence: number;
  }> = {},
) {
  return {
    image_description: "A Windows desktop screenshot with icons and a taskbar.",
    classification_reason: "The image is a screen capture and plausibly matches the topic.",
    off_topic_confidence: 0.1,
    on_topic_confidence: 0.9,
    ...overrides,
  };
}

function createDependencies(
  overrides: Partial<ImageRulesMessageFilterDependencies> = {},
): ImageRulesMessageFilterDependencies & {
  classifyCalls: string[];
  deletedMessages: Array<{ channelId: string; messageId: string }>;
  reactionCalls: Array<{ channelId: string; messageId: string; emoji: string }>;
  dmMessages: Array<{ userId: string; content: string }>;
  auditEvents: Array<{
    eventId: string;
    guildId: string;
    channelId: string;
    messageId?: string;
    image?: {
      imageUrl: string;
      imageDescription: string;
      classificationReason: string;
      offTopicConfidence: number;
      onTopicConfidence: number;
    };
    dryRun?: boolean;
  }>;
  modQueueItems: Array<{
    guildId: string;
    messageId: string;
    imageUrl: string;
    topicDescription: string;
    status: string;
  }>;
  channelMessages: Array<{
    channelId: string;
    content: string;
    embeds: unknown[];
    components: unknown[];
    nonce?: string;
    enforceNonce?: boolean;
  }>;
  readConfigCalls: string[];
} {
  const classifyCalls: string[] = [];
  const deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  const dmMessages: Array<{ userId: string; content: string }> = [];
  const auditEvents: Array<{
    eventId: string;
    guildId: string;
    channelId: string;
    messageId?: string;
    image?: {
      imageUrl: string;
      imageDescription: string;
      classificationReason: string;
      offTopicConfidence: number;
      onTopicConfidence: number;
    };
  }> = [];
  const reactionCalls: Array<{ channelId: string; messageId: string; emoji: string }> = [];
  const modQueueItems: Array<{
    guildId: string;
    messageId: string;
    imageUrl: string;
    topicDescription: string;
    status: string;
  }> = [];
  const channelMessages: Array<{
    channelId: string;
    content: string;
    embeds: unknown[];
    components: unknown[];
    nonce?: string;
    enforceNonce?: boolean;
  }> = [];
  const readConfigCalls: string[] = [];
  return {
    classifyCalls,
    deletedMessages,
    reactionCalls,
    dmMessages,
    auditEvents,
    modQueueItems,
    channelMessages,
    readConfigCalls,
    readConfig: async (guildId) => {
      readConfigCalls.push(guildId);
      return createConfig();
    },
    resolveBotDisplayName: async () => "HAF Bot",
    classifyImage: async ({ imageUrl }) => {
      classifyCalls.push(imageUrl);
      return createClassification();
    },
    deleteChannelMessage: async (channelId, messageId) => {
      deletedMessages.push({ channelId, messageId });
    },
    createReaction: async (channelId, messageId, emoji) => {
      reactionCalls.push({ channelId, messageId, emoji });
    },
    createUserDmMessage: async (userId, body) => {
      dmMessages.push({ userId, content: body.content ?? "" });
    },
    postAuditEvent: async (eventId, data) => {
      auditEvents.push({
        eventId,
        guildId: data.guildId,
        channelId: data.channelId,
        ...(data.messageId && { messageId: data.messageId }),
        ...(data.image && { image: data.image }),
        ...(data.dryRun && { dryRun: data.dryRun }),
      });
    },
    createModQueueItem: async (item) => {
      modQueueItems.push({
        guildId: item.guildId,
        messageId: item.messageId,
        imageUrl: item.imageUrl,
        topicDescription: item.topicDescription,
        status: item.status,
      });
      return { ...item, id: "queue-item-1" };
    },
    setModQueueItemQueueMessage: async () => {},
    createChannelMessage: async (channelId, body) => {
      channelMessages.push({
        channelId,
        content: body.content ?? "",
        embeds: body.embeds ?? [],
        components: body.components ?? [],
        nonce: body.nonce,
        enforceNonce: body.enforce_nonce,
      });
      return { id: "queue-message-1", channel_id: channelId, content: body.content ?? "" };
    },
    ...overrides,
  };
}

test("moderateImageRulesMessageCreate uses injected storage without database bindings", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(
    createMessage(),
    createEnv({ HAF_DB: undefined }),
    dependencies,
  );

  assert.deepEqual(dependencies.readConfigCalls, ["guild-1"]);
  assert.deepEqual(dependencies.classifyCalls, [
    "https://cdn.discordapp.com/attachments/1/1/image.png",
  ]);
});

test("moderateImageRulesMessageCreate does nothing for non-guild messages", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(
    createMessage({ guild_id: undefined }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.readConfigCalls, []);
  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate does nothing when config is missing", async () => {
  const dependencies = createDependencies({ readConfig: async () => null });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate does nothing when config is disabled", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ enabled: false }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate does nothing when the message has no attachments", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(
    createMessage({ attachments: [] }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate does nothing outside configured target channels", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ targetChannelIds: ["other-channel"] }),
  });

  await moderateImageRulesMessageCreate(
    createMessage({ channel_id: "channel-1" }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate treats empty target channels as all channels", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ targetChannelIds: [] }),
  });

  await moderateImageRulesMessageCreate(
    createMessage({ channel_id: "channel-1" }),
    createEnv(),
    dependencies,
  );

  assert.equal(dependencies.classifyCalls.length, 1);
});

test("moderateImageRulesMessageCreate does nothing for excluded roles", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ excludedRoleIds: ["role-1"] }),
  });

  await moderateImageRulesMessageCreate(
    createMessage({ member: { roles: ["role-1", "role-2"] } }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate does nothing when no attachments are classifiable", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(
    createMessage({
      attachments: [
        {
          id: "file-1",
          url: "https://example.com/file.txt",
          content_type: "text/plain",
          size: 100,
        },
      ],
    }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.classifyCalls, []);
});

test("moderateImageRulesMessageCreate passes through on-topic image messages", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.classifyCalls, [
    "https://cdn.discordapp.com/attachments/1/1/image.png",
  ]);
  assert.deepEqual(dependencies.deletedMessages, []);
  assert.deepEqual(dependencies.reactionCalls, []);
  assert.deepEqual(dependencies.dmMessages, []);
  assert.deepEqual(dependencies.auditEvents, []);
});

test("moderateImageRulesMessageCreate reacts to on-topic images when enabled", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ reactOnTopic: true }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.reactionCalls, [
    { channelId: "channel-1", messageId: "message-1", emoji: "✅" },
  ]);
  assert.deepEqual(dependencies.auditEvents, []);
});

test("moderateImageRulesMessageCreate audits on-topic images when enabled", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ auditOnTopic: true }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.reactionCalls, []);
  assert.deepEqual(dependencies.auditEvents, [
    {
      eventId: "image-rule.on-topic",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      image: {
        imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
        imageDescription: "A Windows desktop screenshot with icons and a taskbar.",
        classificationReason: "The image is a screen capture and plausibly matches the topic.",
        offTopicConfidence: 0.1,
        onTopicConfidence: 0.9,
      },
    },
  ]);
});

test("moderateImageRulesMessageCreate continues when on-topic reaction fails", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ reactOnTopic: true, auditOnTopic: true }),
    createReaction: async () => {
      throw new Error("Missing permissions");
    },
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.equal(dependencies.auditEvents.length, 1);
  assert.equal(dependencies.auditEvents[0]?.eventId, "image-rule.on-topic");
});

test("moderateImageRulesMessageCreate dry-run records on-topic without reacting", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ reactOnTopic: true, auditOnTopic: false, dryRun: true }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.reactionCalls, []);
  assert.equal(dependencies.auditEvents.length, 1);
  assert.equal(dependencies.auditEvents[0]?.eventId, "image-rule.on-topic");
  assert.equal(dependencies.auditEvents[0]?.dryRun, true);
});

test("moderateImageRulesMessageCreate dry-run records off-topic without deleting or DMing", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ dryRun: true }),
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.95, on_topic_confidence: 0.05 }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.deletedMessages, []);
  assert.deepEqual(dependencies.dmMessages, []);
  assert.equal(dependencies.auditEvents.length, 1);
  assert.equal(dependencies.auditEvents[0]?.eventId, "image-rule.off-topic-delete");
  assert.equal(dependencies.auditEvents[0]?.dryRun, true);
});

test("moderateImageRulesMessageCreate dry-run records uncertain without queueing", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ modQueueChannelId: "queue-channel-1", dryRun: true }),
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.7, on_topic_confidence: 0.3 }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.deletedMessages, []);
  assert.deepEqual(dependencies.dmMessages, []);
  assert.deepEqual(dependencies.modQueueItems, []);
  assert.equal(dependencies.channelMessages.length, 0);
  assert.equal(dependencies.auditEvents.length, 1);
  assert.equal(dependencies.auditEvents[0]?.eventId, "image-rule.on-topic");
  assert.equal(dependencies.auditEvents[0]?.dryRun, true);
});

for (const source of ["bot", "webhook"] as const) {
  for (const verdict of ["on-topic", "off-topic", "uncertain"] as const) {
    test(`Image Rules preserves ${verdict} moderation for ${source} messages without DMs or reactions`, async () => {
      const dependencies = createDependencies({
        readConfig: async () =>
          createConfig({
            modQueueChannelId: "queue-channel-1",
            reactOnTopic: true,
            auditOnTopic: true,
          }),
        classifyImage: async () =>
          createClassification({
            off_topic_confidence:
              verdict === "off-topic" ? 0.9 : verdict === "uncertain" ? 0.7 : 0.1,
            on_topic_confidence: verdict === "on-topic" ? 0.9 : verdict === "uncertain" ? 0.3 : 0.1,
          }),
      });
      await moderateImageRulesMessageCreate(
        createMessage({
          author: { id: "other-bot", bot: source === "bot" },
          ...(source === "webhook" ? { webhook_id: "webhook-1" } : {}),
        }),
        createEnv(),
        dependencies,
      );
      assert.deepEqual(dependencies.dmMessages, []);
      assert.deepEqual(dependencies.reactionCalls, []);
      assert.equal(dependencies.deletedMessages.length, verdict === "on-topic" ? 0 : 1);
      assert.equal(dependencies.modQueueItems.length, verdict === "uncertain" ? 1 : 0);
      assert.equal(dependencies.channelMessages.length, verdict === "uncertain" ? 1 : 0);
      assert.equal(dependencies.auditEvents.length, verdict === "uncertain" ? 0 : 1);
    });
  }
}

test("moderateImageRulesMessageCreate deletes and DMs for a single off-topic image", async () => {
  const dependencies = createDependencies({
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.9, on_topic_confidence: 0.1 }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
  assert.equal(dependencies.dmMessages.length, 1);
  assert.equal(dependencies.dmMessages[0]?.userId, "user-1");
  assert.match(dependencies.dmMessages[0]?.content ?? "", /DayZ screenshots/);
});

test("moderateImageRulesMessageCreate uses White-Label Bot display name for off-topic DM", async () => {
  const dependencies = createDependencies({
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.9, on_topic_confidence: 0.1 }),
    resolveBotDisplayName: async () => "Custom Bot",
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.equal(dependencies.dmMessages.length, 1);
  assert.match(dependencies.dmMessages[0]?.content ?? "", /deleted by Custom Bot/);
  assert.doesNotMatch(dependencies.dmMessages[0]?.content ?? "", /HAF Bot/);
});

test("moderateImageRulesMessageCreate writes an audit event with the image and classification for off-topic deletion", async () => {
  const dependencies = createDependencies({
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.9, on_topic_confidence: 0.1 }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.auditEvents, [
    {
      eventId: "image-rule.off-topic-delete",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      image: {
        imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
        imageDescription: "A Windows desktop screenshot with icons and a taskbar.",
        classificationReason: "The image is a screen capture and plausibly matches the topic.",
        offTopicConfidence: 0.9,
        onTopicConfidence: 0.1,
      },
    },
  ]);
});

test("moderateImageRulesMessageCreate queues uncertain images for review without audit", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ modQueueChannelId: "queue-channel-1" }),
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.7, on_topic_confidence: 0.3 }),
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
  assert.equal(dependencies.dmMessages.length, 1);
  assert.match(dependencies.dmMessages[0]?.content ?? "", /pending Image Rules Mod Queue review/);
  assert.deepEqual(dependencies.modQueueItems, [
    {
      guildId: "guild-1",
      messageId: "message-1",
      imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
      topicDescription: "DayZ screenshots",
      status: "pending",
    },
  ]);
  assert.equal(dependencies.channelMessages.length, 1);
  assert.equal(dependencies.channelMessages[0]?.channelId, "queue-channel-1");
  assert.equal(dependencies.channelMessages[0]?.nonce, "ir:message-1");
  assert.equal(dependencies.channelMessages[0]?.enforceNonce, true);
  assert.deepEqual(dependencies.auditEvents, []);
});

test("moderateImageRulesMessageCreate uses White-Label Bot display name for uncertain DM", async () => {
  const dependencies = createDependencies({
    readConfig: async () => createConfig({ modQueueChannelId: "queue-channel-1" }),
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.7, on_topic_confidence: 0.3 }),
    resolveBotDisplayName: async () => "Custom Bot",
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.equal(dependencies.dmMessages.length, 1);
  assert.match(dependencies.dmMessages[0]?.content ?? "", /removed by Custom Bot/);
  assert.doesNotMatch(dependencies.dmMessages[0]?.content ?? "", /HAF Bot/);
});

test("moderateImageRulesMessageCreate deletes when any attachment is off-topic", async () => {
  const verdicts = [
    createClassification({ off_topic_confidence: 0.1, on_topic_confidence: 0.9 }),
    createClassification({ off_topic_confidence: 0.92, on_topic_confidence: 0.08 }),
  ];
  const dependencies = createDependencies({
    classifyImage: async () => verdicts.shift() ?? createClassification(),
  });

  await moderateImageRulesMessageCreate(
    createMessage({
      attachments: [
        {
          id: "attachment-1",
          url: "https://cdn.discordapp.com/attachments/1/1/image.png",
          content_type: "image/png",
          size: 1000,
        },
        {
          id: "attachment-2",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          content_type: "image/png",
          size: 1000,
        },
      ],
    }),
    createEnv(),
    dependencies,
  );

  assert.deepEqual(dependencies.deletedMessages, [
    { channelId: "channel-1", messageId: "message-1" },
  ]);
  assert.equal(dependencies.dmMessages.length, 1);
  assert.equal(dependencies.auditEvents.length, 1);
  assert.equal(
    dependencies.auditEvents[0]?.image?.imageUrl,
    "https://cdn.discordapp.com/attachments/1/2/image.png",
  );
  assert.equal(dependencies.auditEvents[0]?.image?.offTopicConfidence, 0.92);
});

test("moderateImageRulesMessageCreate does nothing when classifier env is not configured", async () => {
  const dependencies = createDependencies();

  await moderateImageRulesMessageCreate(
    createMessage(),
    createEnv({ IMAGE_RULES_API_BASE_URL: undefined }),
    dependencies,
  );

  assert.deepEqual(dependencies.classifyCalls, []);
});

for (const error of ["timeout", "5xx", "rate_limited", "parse_error"] as const) {
  test(`moderateImageRulesMessageCreate fails open on classifier ${error}`, async () => {
    let classifyCalls = 0;
    const dependencies = createDependencies({
      classifyImage: async () => {
        classifyCalls++;
        return { error };
      },
    });

    await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

    assert.equal(classifyCalls, 1);
    assert.deepEqual(dependencies.deletedMessages, []);
    assert.deepEqual(dependencies.dmMessages, []);
    assert.deepEqual(dependencies.auditEvents, [
      {
        eventId: "image-rule.classification-failed",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
      },
    ]);
  });
}

test("moderateImageRulesMessageCreate swallows delete races without queue failure", async () => {
  const dependencies = createDependencies({
    classifyImage: async () =>
      createClassification({ off_topic_confidence: 0.9, on_topic_confidence: 0.1 }),
    deleteChannelMessage: async () => {
      throw new Error("Unknown Message");
    },
  });

  await moderateImageRulesMessageCreate(createMessage(), createEnv(), dependencies);

  assert.deepEqual(dependencies.dmMessages, []);
  assert.deepEqual(dependencies.auditEvents, []);
});
