/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  createPermissiveGuildResourceValidator,
  createStaticGuildResourceValidator,
  testChannel,
} from "./helpers/guild-resource-validator";

test("isAuditEventEnabled returns true when event is not in config", async () => {
  const { isAuditEventEnabled } = await import("../src/services/guild-audit-log-service");
  const result = isAuditEventEnabled({ groups: {}, overrides: {} }, "member.join");
  assert.equal(result, true);
});

test("isAuditEventEnabled returns group default when no override", async () => {
  const { isAuditEventEnabled } = await import("../src/services/guild-audit-log-service");
  const result = isAuditEventEnabled({ groups: { member: false }, overrides: {} }, "member.join");
  assert.equal(result, false);
});

test("isAuditEventEnabled returns override when present", async () => {
  const { isAuditEventEnabled } = await import("../src/services/guild-audit-log-service");
  const result = isAuditEventEnabled(
    { groups: { member: false }, overrides: { "member.join": true } },
    "member.join",
  );
  assert.equal(result, true);
});

test("isAuditEventEnabled returns false for override of false", async () => {
  const { isAuditEventEnabled } = await import("../src/services/guild-audit-log-service");
  const result = isAuditEventEnabled(
    { groups: { member: true }, overrides: { "member.join": false } },
    "member.join",
  );
  assert.equal(result, false);
});

test("buildMemberAuditEmbed creates embed for member join", async () => {
  const { buildMemberAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMemberAuditEmbed("member.join", {
    guildId: "guild-1",
    user: { id: "user-1", username: "TestUser" },
  });

  assert.equal(embed.title, "Member Join");
  assert.ok(embed.color);
  assert.ok(embed.fields);
  assert.equal(embed.fields!.length, 1);
  assert.ok(embed.fields![0].value.includes("user-1"));
});

test("buildMemberAuditEmbed creates embed for member ban", async () => {
  const { buildMemberAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMemberAuditEmbed("member.ban", {
    guildId: "guild-1",
    user: { id: "user-1", username: "BannedUser" },
  });

  assert.equal(embed.title, "Member Ban");
  assert.ok(embed.color);
});

test("buildMemberAuditEmbed includes old and new nicknames for nickname change", async () => {
  const { buildMemberAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMemberAuditEmbed("member.nickname-change", {
    guildId: "guild-1",
    user: { id: "user-1", username: "TestUser" },
    nick: "NewNick",
    oldNick: "OldNick",
  });

  assert.equal(embed.title, "Nickname Change");
  const nickField = embed.fields!.find((f) => f.name === "Nickname");
  assert.ok(nickField);
  assert.ok(nickField.value.includes("OldNick"));
  assert.ok(nickField.value.includes("NewNick"));
});

test("buildMessageAuditEmbed creates embed for message delete", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMessageAuditEmbed("message.delete", {
    guildId: "guild-1",
    channelId: "ch-1",
    messageId: "msg-1",
    content: "Hello world",
    author: { id: "user-1", username: "TestUser" },
  });

  assert.equal(embed.title, "Message Deletion");
  assert.ok(embed.fields!.some((f) => f.name === "Author"));
  assert.ok(embed.fields!.some((f) => f.name === "Channel"));
  assert.ok(embed.fields!.some((f) => f.name === "Deleted Content"));
});

test("buildMessageAuditEmbed creates embed for off-topic image deletion with image and confidences", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMessageAuditEmbed("image-rule.off-topic-delete", {
    guildId: "guild-1",
    channelId: "ch-1",
    messageId: "msg-1",
    content: "off topic picture",
    author: { id: "user-1", username: "TestUser" },
    image: {
      imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
      imageDescription: "A Windows desktop screenshot with icons and a taskbar.",
      classificationReason: "The image is a screen capture and plausibly matches the topic.",
      offTopicConfidence: 0.92,
      onTopicConfidence: 0.08,
    },
  });

  assert.equal(embed.title, "Off-Topic Image Deleted");
  assert.ok(embed.fields!.some((f) => f.name === "Author"));
  assert.ok(embed.fields!.some((f) => f.name === "Channel"));
  assert.ok(embed.fields!.some((f) => f.name === "Deleted Content"));
  assert.ok(embed.fields!.some((f) => f.name === "Message ID"));
  assert.ok(embed.fields!.some((f) => f.name === "Image Description"));
  assert.ok(embed.fields!.some((f) => f.name === "Classification Reason"));
  assert.ok(embed.fields!.some((f) => f.name === "Off-Topic Confidence" && f.value === "92.0%"));
  assert.ok(embed.fields!.some((f) => f.name === "On-Topic Confidence" && f.value === "8.0%"));
  assert.equal(embed.image?.url, "https://cdn.discordapp.com/attachments/1/1/image.png");
});

test("buildMessageAuditEmbed creates embed for on-topic image classification", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMessageAuditEmbed("image-rule.on-topic", {
    guildId: "guild-1",
    channelId: "ch-1",
    messageId: "msg-1",
    content: "nice screenshot",
    author: { id: "user-1", username: "TestUser" },
    image: {
      imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
      imageDescription: "A DayZ gameplay screenshot.",
      classificationReason: "The image shows visible DayZ gameplay UI.",
      offTopicConfidence: 0.08,
      onTopicConfidence: 0.92,
    },
  });

  assert.equal(embed.title, "On-Topic Image Classified");
  assert.ok(embed.fields!.some((f) => f.name === "Message Content"));
  assert.ok(embed.fields!.some((f) => f.name === "Image Description"));
  assert.ok(embed.fields!.some((f) => f.name === "Classification Reason"));
  assert.ok(embed.fields!.some((f) => f.name === "Off-Topic Confidence" && f.value === "8.0%"));
  assert.ok(embed.fields!.some((f) => f.name === "On-Topic Confidence" && f.value === "92.0%"));
  assert.equal(embed.image?.url, "https://cdn.discordapp.com/attachments/1/1/image.png");
});

test("buildMessageAuditEmbed marks dry-run events with a (Dry Run) suffix and mode field", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMessageAuditEmbed("image-rule.off-topic-delete", {
    guildId: "guild-1",
    channelId: "ch-1",
    messageId: "msg-1",
    author: { id: "user-1", username: "TestUser" },
    image: {
      imageUrl: "https://cdn.discordapp.com/attachments/1/1/image.png",
      imageDescription: "Random photo",
      classificationReason: "Photo is not a DayZ screenshot.",
      offTopicConfidence: 0.9,
      onTopicConfidence: 0.1,
    },
    dryRun: true,
  });

  assert.match(embed.title ?? "", /\(Dry Run\)$/);
  assert.ok(embed.fields!.some((f) => f.name === "Mode"));
  assert.equal(embed.color, 0x95a5a6);
});

test("buildMessageAuditEmbed creates embed for message update", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildMessageAuditEmbed("message.update", {
    guildId: "guild-1",
    channelId: "ch-1",
    content: "New content",
    oldContent: "Old content",
  });

  assert.equal(embed.title, "Message Update");
  assert.ok(embed.fields!.some((f) => f.name === "Before"));
  assert.ok(embed.fields!.some((f) => f.name === "New Content"));
});

test("buildStructureAuditEmbed creates embed for channel create", async () => {
  const { buildStructureAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildStructureAuditEmbed("guild-structure.channel-create", {
    guildId: "guild-1",
    channelId: "ch-1",
    channelName: "general",
    channelType: 0,
  });

  assert.equal(embed.title, "Channel Creation");
  assert.ok(embed.fields!.some((f) => f.name === "Channel"));
});

test("buildStructureAuditEmbed creates embed for channel delete", async () => {
  const { buildStructureAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildStructureAuditEmbed("guild-structure.channel-delete", {
    guildId: "guild-1",
    channelId: "ch-1",
    channelName: "old-channel",
  });

  assert.equal(embed.title, "Channel Deletion");
  assert.ok(embed.fields!.some((f) => f.value.includes("old-channel")));
});

test("buildStructureAuditEmbed creates embed for invite create", async () => {
  const { buildStructureAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildStructureAuditEmbed("guild-structure.invite-create", {
    guildId: "guild-1",
    channelId: "ch-1",
    inviteCode: "abc123",
    inviter: { id: "user-1", username: "Inviter" },
  });

  assert.equal(embed.title, "Invite Creation");
  assert.ok(embed.fields!.some((f) => f.name === "Invite Code"));
});

test("buildStructureAuditEmbed includes actor when known", async () => {
  const { buildStructureAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const embed = buildStructureAuditEmbed("guild-structure.channel-create", {
    guildId: "guild-1",
    channelId: "ch-1",
    channelName: "new-channel",
    actor: { id: "admin-1", username: "Admin" },
  });

  assert.ok(embed.fields!.some((f) => f.name === "Actor"));
});

test("buildMessageAuditEmbed truncates long content", async () => {
  const { buildMessageAuditEmbed } = await import("../src/services/guild-audit-log-service");
  const longContent = "x".repeat(1000);
  const embed = buildMessageAuditEmbed("message.update", {
    guildId: "guild-1",
    channelId: "ch-1",
    content: longContent,
  });

  const newContentField = embed.fields!.find((f) => f.name === "New Content");
  assert.ok(newContentField);
  assert.ok(newContentField.value.length <= 510);
  assert.ok(newContentField.value.endsWith("..."));
});

test("resolveAuditChannelId respects disabled Guild Audit Log event fallback", async () => {
  const { resolveAuditChannelId } = await import("../src/services/guild-audit-log-service");
  const store = {
    async readConfig() {
      return {
        guildId: "guild-1",
        auditChannelId: "audit-channel-1",
        groupChannelIds: {},
        eventStates: { groups: { lfg: false }, overrides: {} },
        updatedAtMs: 0,
      };
    },
    async upsertConfig() {},
  };

  assert.equal(await resolveAuditChannelId("guild-1", null, store, "lfg.post-create"), null);
});

test("resolveAuditChannelId returns feature channel even when Guild Audit Log event is disabled", async () => {
  const { resolveAuditChannelId } = await import("../src/services/guild-audit-log-service");
  const store = {
    async readConfig() {
      return {
        guildId: "guild-1",
        auditChannelId: "audit-channel-1",
        groupChannelIds: {},
        eventStates: { groups: { lfg: false }, overrides: {} },
        updatedAtMs: 0,
      };
    },
    async upsertConfig() {},
  };

  assert.equal(
    await resolveAuditChannelId("guild-1", "feature-channel-1", store, "lfg.post-create"),
    "feature-channel-1",
  );
});

test("resolveAuditChannelId returns group channel when no feature channel is set", async () => {
  const { resolveAuditChannelId } = await import("../src/services/guild-audit-log-service");
  const store = {
    async readConfig() {
      return {
        guildId: "guild-1",
        auditChannelId: "audit-channel-1",
        groupChannelIds: { message: "message-channel-1" },
        eventStates: { groups: {}, overrides: {} },
        updatedAtMs: 0,
      };
    },
    async upsertConfig() {},
  };

  assert.equal(
    await resolveAuditChannelId("guild-1", null, store, "message.delete"),
    "message-channel-1",
  );
});

test("resolveAuditChannelId falls back to default audit channel when group has no channel", async () => {
  const { resolveAuditChannelId } = await import("../src/services/guild-audit-log-service");
  const store = {
    async readConfig() {
      return {
        guildId: "guild-1",
        auditChannelId: "audit-channel-1",
        groupChannelIds: { member: "member-channel-1" },
        eventStates: { groups: {}, overrides: {} },
        updatedAtMs: 0,
      };
    },
    async upsertConfig() {},
  };

  assert.equal(
    await resolveAuditChannelId("guild-1", null, store, "message.delete"),
    "audit-channel-1",
  );
});

test("postMessageAuditEvent routes message events to a per-group channel", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-2", channel_id: "message-channel-1" }));
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: { message: "message-channel-1" },
          eventStates: { groups: {}, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "regular-channel-1",
        messageId: "msg-1",
        content: "updated",
        author: { id: "user-1", username: "User" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 1);
    assert.ok(String(fetchCalls[0]?.input).includes("/channels/message-channel-1/messages"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gateway audit posts forward enforced dedupe nonces and rethrow delivery failures", async () => {
  const bodies: Array<{ nonce?: string; enforce_nonce?: boolean }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { nonce?: string; enforce_nonce?: boolean });
    return new Response("upstream failed", { status: 503 });
  };

  try {
    const { postMemberAuditEvent } = await import("../src/services/guild-audit-log-service");
    await assert.rejects(
      postMemberAuditEvent(
        "member.join",
        { guildId: "guild-1", user: { id: "member-1" } },
        auditConfigStore(),
        "bot-token",
        true,
        "g:11111111:22222222",
      ),
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.nonce, "g:11111111:22222222");
    assert.equal(bodies[0]?.enforce_nonce, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postMessageAuditEvent suppresses Discord message events from an excluded channel", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1", channel_id: "audit-channel-1" });
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.delete",
      {
        guildId: "guild-1",
        channelId: "excluded-channel-1",
        messageId: "message-1",
        author: { id: "member-1" },
      },
      {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: {}, overrides: {} },
          excludedChannelIds: ["excluded-channel-1"],
          excludedRoleIds: [],
          updatedAtMs: 0,
        }),
        upsertConfig: async () => {},
      },
      "bot-token",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord message events inherit an excluded parent channel", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "thread-1",
        parentChannelId: "excluded-forum-1",
        author: { id: "member-1" },
      },
      auditConfigStore({ excludedChannelIds: ["excluded-forum-1"] }),
      "bot-token",
    );
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord message events resolve missing channel ancestry and inherit the parent policy", async () => {
  const fetchUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchUrls.push(String(input));
    return Response.json({ id: "thread-1", type: 11, parent_id: "excluded-parent-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.update",
      { guildId: "guild-1", channelId: "thread-1", author: { id: "member-1" } },
      auditConfigStore({ excludedChannelIds: ["excluded-parent-1"] }),
      "bot-token",
    );
    assert.deepEqual(fetchUrls, ["https://discord.com/api/v10/channels/thread-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invite creation is suppressed by channel exclusions while channel lifecycle events remain visible", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postStructureAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = auditConfigStore({ excludedChannelIds: ["excluded-channel-1"] });
    await postStructureAuditEvent(
      "guild-structure.invite-create",
      { guildId: "guild-1", channelId: "excluded-channel-1" },
      store,
      "bot-token",
    );
    for (const eventId of [
      "guild-structure.channel-create",
      "guild-structure.channel-update",
      "guild-structure.channel-delete",
    ] as const) {
      await postStructureAuditEvent(
        eventId,
        { guildId: "guild-1", channelId: "excluded-channel-1", channelName: "private" },
        store,
        "bot-token",
      );
    }
    assert.equal(fetchCalls.length, 3);
    for (const call of fetchCalls) {
      assert.match(String(call), /channels\/audit-channel-1\/messages/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("member lifecycle events remain visible to role exclusions", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMemberAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = auditConfigStore({ excludedRoleIds: ["excluded-role"] });
    for (const eventId of ["member.join", "member.leave", "member.ban", "member.unban"] as const) {
      await postMemberAuditEvent(
        eventId,
        { guildId: "guild-1", user: { id: "member-1" }, memberRoleIds: ["excluded-role"] },
        store,
        "bot-token",
      );
    }
    assert.equal(fetchCalls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord message events use ANY-role matching", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.delete",
      {
        guildId: "guild-1",
        channelId: "channel-1",
        author: { id: "member-1" },
        memberRoleIds: ["ordinary-role", "excluded-role"],
      },
      auditConfigStore({ excludedRoleIds: ["excluded-role", "other-excluded-role"] }),
      "bot-token",
    );
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Discord message deletions resolve current member roles from retained author attribution", async () => {
  const fetchUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchUrls.push(String(input));
    return Response.json({ user: { id: "member-1" }, roles: ["excluded-role"] });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.delete",
      {
        guildId: "guild-1",
        channelId: "channel-1",
        author: { id: "member-1" },
      },
      auditConfigStore({ excludedRoleIds: ["excluded-role"] }),
      "bot-token",
    );
    assert.deepEqual(fetchUrls, ["https://discord.com/api/v10/guilds/guild-1/members/member-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing Discord Audit Event attribution fails open", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "message.delete",
      { guildId: "guild-1", channelId: "channel-1" },
      auditConfigStore({ excludedRoleIds: ["excluded-role"] }),
      "bot-token",
    );
    assert.equal(fetchCalls.length, 1);
    assert.match(String(fetchCalls[0]), /channels\/audit-channel-1\/messages/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HAF Audit Events are immune to the Audit Exclusion Policy", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "image-rule.off-topic-delete",
      {
        guildId: "guild-1",
        channelId: "excluded-channel-1",
        author: { id: "member-1" },
        memberRoleIds: ["excluded-role"],
      },
      auditConfigStore({
        excludedChannelIds: ["excluded-channel-1"],
        excludedRoleIds: ["excluded-role"],
      }),
      "bot-token",
    );
    assert.equal(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("member role-change exclusions use post-event membership", async () => {
  const fetchCalls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetchCalls.push(input);
    return Response.json({ id: "audit-1" });
  };
  try {
    const { postMemberAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = auditConfigStore({ excludedRoleIds: ["excluded-a", "excluded-b"] });

    await postMemberAuditEvent(
      "member.role-assign",
      { guildId: "guild-1", roles: ["excluded-a"], memberRoleIds: ["excluded-a"] },
      store,
      "bot-token",
    );
    await postMemberAuditEvent(
      "member.role-remove",
      { guildId: "guild-1", roles: ["excluded-a"], memberRoleIds: [] },
      store,
      "bot-token",
    );
    await postMemberAuditEvent(
      "member.role-remove",
      { guildId: "guild-1", roles: ["excluded-a"], memberRoleIds: ["excluded-b"] },
      store,
      "bot-token",
    );
    await postMemberAuditEvent(
      "member.nickname-change",
      {
        guildId: "guild-1",
        oldNick: "Before",
        nick: "After",
        memberRoleIds: ["excluded-b"],
      },
      store,
      "bot-token",
    );

    assert.equal(fetchCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postPlayerCountAuditEvent rejects a persisted foreign audit destination before Discord", async () => {
  let discordCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    discordCalls += 1;
    throw new Error("Unexpected Discord call");
  };

  try {
    const { postPlayerCountAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postPlayerCountAuditEvent(
      "player-count.fetch-failed",
      {
        guildId: "guild-1",
        serverId: "server-1",
        serverName: "Main PvP",
        identifier: "1.2.3.4:27015",
        errorMessage: "Server unavailable",
        streakCount: 3,
      },
      {
        async readConfig() {
          return {
            guildId: "guild-1",
            auditChannelId: "foreign-audit",
            groupChannelIds: {},
            eventStates: { groups: { "player-count": true }, overrides: {} },
            updatedAtMs: 0,
          };
        },
        async upsertConfig() {},
      },
      "bot-token",
      createStaticGuildResourceValidator({
        guilds: {
          "guild-1": { channels: [], roles: [] },
          "guild-2": {
            channels: [testChannel("foreign-audit", 0, "guild-2")],
            roles: [],
          },
        },
      }),
    );

    assert.equal(discordCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function auditConfigStore(
  exclusions: { excludedChannelIds?: string[]; excludedRoleIds?: string[] } = {},
) {
  return {
    readConfig: async () => ({
      guildId: "guild-1",
      auditChannelId: "audit-channel-1",
      groupChannelIds: {},
      eventStates: { groups: {}, overrides: {} },
      excludedChannelIds: exclusions.excludedChannelIds ?? [],
      excludedRoleIds: exclusions.excludedRoleIds ?? [],
      updatedAtMs: 0,
    }),
    upsertConfig: async () => {},
  };
}

test("Mention Protection audit posts use a deterministic enforced nonce", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: "audit-1", channel_id: "audit-channel-1" });
  };
  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    await postMessageAuditEvent(
      "mention-protection.delete",
      {
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "123456789012345678",
        content: "removed",
        author: { id: "user-1" },
      },
      {
        readConfig: async () => ({
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: {}, overrides: {} },
          updatedAtMs: 0,
        }),
        upsertConfig: async () => {},
      },
      "bot-token",
    );

    assert.equal(bodies[0]?.nonce, "a:123456789012345678");
    assert.equal(bodies[0]?.enforce_nonce, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postMessageAuditEvent skips messages posted in the per-group channel", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "message-channel-1" }));
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: { message: "message-channel-1" },
          eventStates: { groups: {}, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "message-channel-1",
        messageId: "msg-1",
        content: "updated",
        author: { id: "user-1", username: "User" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postMessageAuditEvent skips messages posted in the audit channel", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { message: true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "audit-channel-1",
        messageId: "msg-1",
        content: "updated",
        author: { id: "user-1", username: "User" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postMessageAuditEvent skips messages authored by the bot", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { message: true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "regular-channel-1",
        messageId: "msg-1",
        content: "updated",
        author: { id: "bot-user-id", username: "Bot" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postMessageAuditEvent posts a message for regular user message updates", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-2", channel_id: "audit-channel-1" }));
  };

  try {
    const { postMessageAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { message: true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postMessageAuditEvent(
      "message.update",
      {
        guildId: "guild-1",
        channelId: "regular-channel-1",
        messageId: "msg-1",
        content: "updated",
        author: { id: "user-1", username: "User" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 1);
    assert.ok(String(fetchCalls[0]?.input).includes("/channels/audit-channel-1/messages"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postStructureAuditEvent skips events in the audit channel", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postStructureAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { "guild-structure": true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postStructureAuditEvent(
      "guild-structure.channel-update",
      {
        guildId: "guild-1",
        channelId: "audit-channel-1",
        channelName: "audit-log",
        channelType: 0,
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postStructureAuditEvent skips invite creates from the bot", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postStructureAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { "guild-structure": true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postStructureAuditEvent(
      "guild-structure.invite-create",
      {
        guildId: "guild-1",
        channelId: "channel-1",
        inviteCode: "abc123",
        inviter: { id: "bot-user-id", username: "Bot" },
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postPlayerCountAuditEvent posts a fetch-failed event when the player-count group is enabled", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postPlayerCountAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { "player-count": true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postPlayerCountAuditEvent(
      "player-count.fetch-failed",
      {
        guildId: "guild-1",
        serverId: "server-1",
        serverName: "Main PvP",
        identifier: "1.2.3.4:27015",
        errorMessage: "Server 1.2.3.4:27015 not found in Steam directory",
        streakCount: 3,
      },
      store,
      "bot-token",
      createPermissiveGuildResourceValidator(),
    );

    assert.equal(fetchCalls.length, 1);
    assert.ok(String(fetchCalls[0]?.input).includes("/channels/audit-channel-1/messages"));
    const init = fetchCalls[0]?.init as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.embeds[0].title, "🎮 Player Count Fetch Failed");
    assert.ok(
      body.embeds[0].fields.some((f: { name: string; value: string }) => f.name === "Game Server"),
    );
    assert.ok(
      body.embeds[0].fields.some(
        (f: { name: string; value: string }) =>
          f.name === "Identifier" && f.value === "1.2.3.4:27015",
      ),
    );
    assert.ok(
      body.embeds[0].fields.some(
        (f: { name: string; value: string }) =>
          f.name === "Consecutive Failures" && f.value === "3",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postPlayerCountAuditEvent skips when the player-count group is disabled", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postPlayerCountAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { "player-count": false }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postPlayerCountAuditEvent(
      "player-count.fetch-failed",
      {
        guildId: "guild-1",
        serverId: "server-1",
        serverName: "Main PvP",
        identifier: "1.2.3.4:27015",
        errorMessage: "Server 1.2.3.4:27015 not found in Steam directory",
        streakCount: 3,
      },
      store,
      "bot-token",
      createPermissiveGuildResourceValidator(),
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postPlayerCountAuditEvent skips when no audit channel is configured", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postPlayerCountAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "",
          groupChannelIds: {},
          eventStates: { groups: {}, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postPlayerCountAuditEvent(
      "player-count.fetch-failed",
      {
        guildId: "guild-1",
        serverId: "server-1",
        serverName: "Main PvP",
        identifier: "1.2.3.4:27015",
        errorMessage: "Server 1.2.3.4:27015 not found in Steam directory",
        streakCount: 3,
      },
      store,
      "bot-token",
      createPermissiveGuildResourceValidator(),
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postStructureAuditEvent posts a channel create event from a regular user", async () => {
  const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return new Response(JSON.stringify({ id: "msg-1", channel_id: "audit-channel-1" }));
  };

  try {
    const { postStructureAuditEvent } = await import("../src/services/guild-audit-log-service");
    const store = {
      async readConfig() {
        return {
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: { "guild-structure": true }, overrides: {} },
          updatedAtMs: 0,
        };
      },
      async upsertConfig() {},
    };

    await postStructureAuditEvent(
      "guild-structure.channel-create",
      {
        guildId: "guild-1",
        channelId: "channel-1",
        channelName: "general",
        channelType: 0,
      },
      store,
      "bot-token",
      "bot-user-id",
    );

    assert.equal(fetchCalls.length, 1);
    assert.ok(String(fetchCalls[0]?.input).includes("/channels/audit-channel-1/messages"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("channel permissions copied event is labelled and belongs to Guild Structure", async () => {
  const { AUDIT_EVENT_GROUP_MEMBERS, AUDIT_EVENT_LABELS } = await import("../src/types");

  assert.equal(
    AUDIT_EVENT_LABELS["guild-structure.channel-permissions-copied"],
    "Channel Permissions Copied",
  );
  assert.ok(
    AUDIT_EVENT_GROUP_MEMBERS["guild-structure"].includes(
      "guild-structure.channel-permissions-copied",
    ),
  );
});

test("postChannelPermissionsCopiedAuditEvent posts the complete summary with a deterministic nonce", async () => {
  const calls: Array<{ input: unknown; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "audit-1", channel_id: "structure-audit-channel" });
  };
  try {
    const { postChannelPermissionsCopiedAuditEvent } =
      await import("../src/services/guild-audit-log-service");
    const data = {
      guildId: "guild-1",
      actorUserId: "actor-1",
      sourceChannelId: "source-1",
      sourceChannelName: "staff-source",
      targetChannelId: "target-1",
      targetChannelName: "staff-target",
      mode: "roles_only" as const,
      addedCount: 2,
      changedCount: 3,
      removedCount: 1,
      retainedCount: 4,
      memberOverwritesAffected: true,
      timestampMs: Date.parse("2026-07-27T12:34:56.000Z"),
      correlationId: "01983f70-8358-7000-8000-000000000001",
    };
    const store = {
      readConfig: async () => ({
        guildId: "guild-1",
        auditChannelId: "default-audit-channel",
        groupChannelIds: { "guild-structure": "structure-audit-channel" },
        eventStates: { groups: {}, overrides: {} },
        updatedAtMs: 0,
      }),
      upsertConfig: async () => {},
    };

    await postChannelPermissionsCopiedAuditEvent(data, store, "bot-token");
    await postChannelPermissionsCopiedAuditEvent(data, store, "bot-token");

    assert.equal(calls.length, 2);
    assert.match(String(calls[0]?.input), /channels\/structure-audit-channel\/messages/);
    const first = calls[0]!.body as {
      embeds: Array<{
        title: string;
        timestamp: string;
        fields: Array<{ name: string; value: string }>;
      }>;
      allowed_mentions: unknown;
      enforce_nonce: boolean;
      nonce: string;
    };
    const second = calls[1]!.body as { nonce: string };
    assert.equal(first.embeds[0].title, "Channel Permissions Copied");
    assert.equal(first.embeds[0].timestamp, "2026-07-27T12:34:56.000Z");
    assert.deepEqual(
      Object.fromEntries(first.embeds[0].fields.map((field) => [field.name, field.value])),
      {
        Actor: "<@actor-1>\nID: actor-1",
        "Source Channel": "staff-source\nID: source-1",
        "Target Channel": "staff-target\nID: target-1",
        Mode: "Role permissions only",
        "Overwrite Changes": "Added: 2\nChanged: 3\nRemoved: 1\nRetained: 4",
        "Member-specific Overwrites Affected": "Yes",
        "Correlation ID": "01983f70-8358-7000-8000-000000000001",
      },
    );
    assert.deepEqual(first.allowed_mentions, { parse: [] });
    assert.equal(first.enforce_nonce, true);
    assert.match(first.nonce, /^cpc:[A-Za-z0-9_-]{21}$/);
    assert.equal(first.nonce, second.nonce);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("postChannelPermissionsCopiedAuditEvent is best-effort", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let logged = false;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  console.error = () => {
    logged = true;
  };
  try {
    const { postChannelPermissionsCopiedAuditEvent } =
      await import("../src/services/guild-audit-log-service");
    await assert.doesNotReject(
      postChannelPermissionsCopiedAuditEvent(
        {
          guildId: "guild-1",
          actorUserId: "actor-1",
          sourceChannelId: "source-1",
          sourceChannelName: "source",
          targetChannelId: "target-1",
          targetChannelName: "target",
          mode: "exact",
          addedCount: 0,
          changedCount: 0,
          removedCount: 1,
          retainedCount: 0,
          memberOverwritesAffected: false,
          timestampMs: 1,
          correlationId: "correlation-1",
        },
        auditConfigStore(),
        "bot-token",
      ),
    );
    assert.equal(logged, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
