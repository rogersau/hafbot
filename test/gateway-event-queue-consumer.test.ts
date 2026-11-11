import { gatewayEnvelope } from "./support/gateway-envelope";
import type { QueueBatch } from "../src/runtime/queue-types";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  deliverGatewayEventQueueBatch,
  processGatewayEventQueueMessages as processGatewayEventQueueMessagesRuntime,
} from "./support/gateway-event-consumer";
import { createSqliteGuildAuditLogStore } from "./support/sqlite/runtime/sqlite-guild-audit-log-store";
import { createSqliteGuildRbacStore } from "./support/sqlite/runtime/sqlite-guild-rbac-store";
import { createSqliteGuildPlanProjectionStore } from "./support/sqlite/runtime/sqlite-guild-plan-projection-store";
import { buildMemberVerificationCustomId } from "../src/services/member-verification-service";
import { createSqliteMemberVerificationStore } from "./support/sqlite/runtime/sqlite-member-verification-store";
import { createSqliteMentionProtectionStore } from "./support/sqlite/runtime/sqlite-mention-protection-store";
import { createSqliteManagedMessageStore } from "./support/sqlite/runtime/sqlite-managed-message-store";
import { createSqlitePlatformLinkStore } from "./support/sqlite/runtime/sqlite-platform-link-store";
import { createSqliteServerLevelStore } from "./support/sqlite/runtime/sqlite-server-level-store";
import { createSqliteTimedRoleStore } from "./support/sqlite/runtime/sqlite-timed-role-store";
import { createSqliteTicketStore } from "./support/sqlite/runtime/sqlite-ticket-store";
import { createSqliteWhiteLabelBotStore } from "./support/sqlite/runtime/sqlite-white-label-bot-store";
import type {
  PlatformLink,
  PlatformLinkConfig,
} from "../src/runtime/contracts/platform-link-store";
import { createLegacyCommunityStoreDatabase } from "./helpers/legacy-community-store-d1";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";
import { deriveGatewayEventKey } from "../src/runtime/gateway-event-idempotency";
import { createGatewayEventOperationStore } from "./support/sqlite-gateway-operation-store";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

function processGatewayEventQueueMessages(
  messages: unknown[],
  env: Parameters<typeof processGatewayEventQueueMessagesRuntime>[1],
  logger: Parameters<typeof processGatewayEventQueueMessagesRuntime>[2] = console,
) {
  return processGatewayEventQueueMessagesRuntime(messages, env, logger, {
    guildResources: createPermissiveGuildResourceValidator(),
  });
}

test("processGatewayEventQueueMessages moderates reaction add events", async () => {
  const storeFetches: string[] = [];
  const fetchCalls: Array<{ input: string; method: string | undefined }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({ input: String(input), method: init?.method });
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_REACTION_ADD",
          data: {
            channel_id: "channel-1",
            message_id: "message-1",
            guild_id: "guild-1",
            emoji: { id: null, name: "✅", animated: false },
            user_id: "user-1",
          },
        }),
      ],
      createGatewayConsumerEnv({
        moderationStoreFetch(input) {
          storeFetches.push(String(input));
          return Response.json({
            guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
            botUserId: "bot-1",
          });
        },
      }),
    );

    assert.deepEqual(storeFetches, ["https://community-store/config"]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.method, "DELETE");
    assert.match(fetchCalls[0]?.input ?? "", /\/reactions\/%E2%9C%85\/user-1$/);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages handles message create moderation", async () => {
  const storeFetches: string[] = [];
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    if (String(input).endsWith("/users/@me/channels")) {
      return Response.json({ id: "dm-channel-1" });
    }

    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_CREATE",
          data: {
            id: "message-9",
            channel_id: "channel-9",
            guild_id: "guild-1",
            content: "please no ✅ here",
            author: { id: "user-9", username: "member-9" },
          },
        }),
      ],
      createGatewayConsumerEnv({
        moderationStoreFetch(input) {
          storeFetches.push(String(input));
          return Response.json({
            guilds: { "guild-1": { enabled: true, emojis: ["✅"] } },
            botUserId: "bot-1",
          });
        },
      }),
    );

    assert.deepEqual(storeFetches, ["https://community-store/config"]);
    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[0]?.method, "DELETE");
    assert.match(fetchCalls[0]?.input ?? "", /\/channels\/channel-9\/messages\/message-9$/);
    assert.equal(fetchCalls[1]?.method, "POST");
    assert.match(fetchCalls[1]?.input ?? "", /\/users\/@me\/channels$/);
    assert.equal(fetchCalls[2]?.method, "POST");
    assert.match(fetchCalls[2]?.input ?? "", /\/channels\/dm-channel-1\/messages$/);
    assert.match(fetchCalls[2]?.body ?? "", /Blocked emoji: ✅/);
  } finally {
    restore();
  }
});

test("non-member Gateway events do not construct Member Verification", async () => {
  await processGatewayEventQueueMessages(
    [gatewayEnvelope({ type: "UNHANDLED_EVENT", data: { guild_id: "guild-1" } })],
    createGatewayConsumerEnv({
      enableMemberVerification: true,
      componentIdSigningSecret: "too-short",
    }),
  );
});

test("processGatewayEventQueueMessages lets a configured HAF admin use !send", async () => {
  const database = new SqliteD1Database();
  const d1 = database as unknown as D1Database;
  const tickets = createSqliteTicketStore(d1);
  await tickets.upsertTicketPanelConfig({
    guildId: "guild-1",
    panelId: "main",
    panelName: "Main panel",
    panelChannelId: "panel-channel-1",
    categoryChannelId: "ticket-category-1",
    transcriptChannelId: "transcript-channel-1",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "support-role",
        channelNamePrefix: "support",
        questions: [],
        responseRules: [],
        anonymousSupportEnabled: true,
        staffDiscussionThreadEnabled: true,
        ticketHistoryPromptVisibility: "off",
        limitExclusion: false,
        mentionSupportRole: false,
      },
    ],
  });
  await tickets.createTicketInstance({
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    panelId: "main",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "member-1",
    supportRoleId: "support-role",
    status: "open",
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: "staff-thread-1",
  });
  await createSqliteGuildRbacStore(d1).upsertGuildAdminRoleId("guild-1", "haf-admin-role");

  const requests: Array<{ url: string; method: string; body: string }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const request = {
      url: String(input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    };
    requests.push(request);
    if (request.method === "POST" && request.url.endsWith("/channels/ticket-channel-1/messages")) {
      return Response.json({
        id: "anonymous-reply-1",
        channel_id: "ticket-channel-1",
        content: "Hello from admin",
      });
    }
    throw new Error(`Unexpected Discord request: ${request.method} ${request.url}`);
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_CREATE",
          data: {
            id: "admin-message-1",
            channel_id: "staff-thread-1",
            guild_id: "guild-1",
            content: "!send Hello from admin",
            type: 0,
            author: { id: "admin-1" },
            member: { roles: ["haf-admin-role"] },
          },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: d1 }),
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), {
      content: "Hello from admin",
      allowed_mentions: { parse: [] },
      nonce: "ts:admin-message-1",
      enforce_nonce: true,
    });
    assert.equal(
      (
        await tickets.readStaffMessageMappingByStaffMessage({
          guildId: "guild-1",
          staffThreadId: "staff-thread-1",
          staffMessageId: "admin-message-1",
        })
      )?.botMessageId,
      "anonymous-reply-1",
    );
  } finally {
    restore();
  }
});

test("Managed Message deletion redelivery marks Missing once, audits once, and suppresses generic deletion", async () => {
  const database = new SqliteD1Database();
  await createSqliteManagedMessageStore(database as unknown as D1Database).upsert({
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "message-1",
    embeds: [{ description: "Rules", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 1,
  });
  const bodies: string[] = [];
  const { restore } = interceptDiscordFetch(async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ id: "audit-message-1" });
  });
  const envelope = gatewayEnvelope({
    type: "MESSAGE_DELETE",
    data: { id: "message-1", guild_id: "guild-1", channel_id: "channel-1" },
  });

  try {
    await processGatewayEventQueueMessages(
      [envelope, envelope],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.equal(bodies.length, 1);
    assert.match(bodies[0] ?? "", /Managed Message Deleted Outside HAF/i);
    assert.doesNotMatch(bodies[0] ?? "", /Message Deleted"/i);
    assert.equal(
      (
        await createSqliteManagedMessageStore(database as unknown as D1Database).readById(
          "guild-1",
          "managed-1",
        )
      )?.status,
      "missing",
    );
  } finally {
    restore();
  }
});

test("gateway member updates apply Audit Exclusion Policy roles using post-event membership", async () => {
  const database = new SqliteD1Database();
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    excludedChannelIds: [],
    excludedRoleIds: ["excluded-role"],
    updatedAtMs: 1,
  });
  const auditBodies: string[] = [];
  const { restore } = interceptDiscordFetch(async (_input, init) => {
    auditBodies.push(String(init?.body ?? ""));
    return Response.json({ id: "audit-message-1" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_UPDATE",
          previousRoleIds: [],
          data: {
            guild_id: "guild-1",
            user: { id: "member-1" },
            roles: ["excluded-role"],
          },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_UPDATE",
          previousRoleIds: ["excluded-role"],
          data: { guild_id: "guild-1", user: { id: "member-1" }, roles: [] },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.equal(auditBodies.length, 1);
    assert.match(auditBodies[0] ?? "", /Role Removal/);
  } finally {
    restore();
  }
});

test("Managed Message deletion retries a failed pending audit after the record is Missing", async () => {
  const clock = mockDateNow(1_000);
  const database = new SqliteD1Database();
  const managedMessages = createSqliteManagedMessageStore(database as unknown as D1Database);
  await managedMessages.upsert({
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "message-1",
    embeds: [{ description: "Rules", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 1,
  });
  let attempts = 0;
  const { restore } = interceptDiscordFetch(async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ id: "audit-message-1" });
  });
  const envelope = gatewayEnvelope({
    type: "MESSAGE_DELETE",
    data: { id: "message-1", guild_id: "guild-1", channel_id: "channel-1" },
  });

  try {
    await assert.rejects(
      processGatewayEventQueueMessages(
        [envelope],
        createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
      ),
      /Discord API error: 503/,
    );
    const missing = await managedMessages.readById("guild-1", "managed-1");
    assert.ok(missing);
    await managedMessages.upsert({
      ...missing,
      messageId: "message-2",
      status: "published",
      updatedAtMs: 2,
    });
    clock.set(121_001);
    await processGatewayEventQueueMessages(
      [envelope],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );
    await processGatewayEventQueueMessages(
      [envelope],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.equal(attempts, 2);
  } finally {
    clock.restore();
    restore();
  }
});

test("processGatewayEventQueueMessages routes creates and updates through Mention Protection", async () => {
  const database = new SqliteD1Database();
  const config = createDefaultMentionProtectionConfig("guild-1", 100);
  config.spamEnabled = true;
  config.massMentionThreshold = 2;
  await createSqliteMentionProtectionStore(database as unknown as D1Database).upsertConfig(config);
  await createSqliteGuildPlanProjectionStore(
    database as unknown as D1Database,
  ).upsertGuildPlanProjection({ guildId: "guild-1", plan: "premium", updatedAtMs: 100 });
  const calls: Array<{ url: string; method: string }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET" && url.endsWith("/channels/channel-1")) {
      return Response.json({ id: "channel-1", type: 0 });
    }
    if (method === "POST") {
      return Response.json({ id: "warning-1", channel_id: "channel-1", content: "" });
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_CREATE",
          data: {
            id: "message-1",
            channel_id: "channel-1",
            guild_id: "guild-1",
            content: "<@user-2> <@user-3>",
            timestamp: "2026-07-13T00:00:00.000Z",
            type: 0,
            author: { id: "user-1", username: "member" },
            member: { roles: [] },
            mentions: [{ id: "user-2" }, { id: "user-3" }],
            mention_roles: [],
            mention_everyone: false,
          },
        }),
        gatewayEnvelope({
          type: "MESSAGE_UPDATE",
          data: {
            id: "message-2",
            channel_id: "channel-1",
            guild_id: "guild-1",
            content: "<@user-5> <@user-6>",
            timestamp: "2026-07-13T00:00:01.000Z",
            edited_timestamp: "2026-07-13T00:00:02.000Z",
            type: 0,
            author: { id: "user-4", username: "member-2" },
            member: { roles: [] },
            mentions: [{ id: "user-5" }, { id: "user-6" }],
            mention_roles: [],
            mention_everyone: false,
          },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        enableMentionProtection: true,
      }),
    );
  } finally {
    restore();
  }

  assert.equal(
    calls.some(({ method }) => method === "POST"),
    true,
  );
  assert.deepEqual(
    calls
      .filter(({ method }) => method === "DELETE")
      .map(({ url }) => url.match(/messages\/(message-\d)$/)?.[1]),
    ["message-1", "message-2"],
  );
});

test("processGatewayEventQueueMessages logs guild lifecycle events", async () => {
  const database = new SqliteD1Database();
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          data: {
            id: "guild-1",
            name: "Guild One",
            member_count: 100,
            owner_id: "owner-1",
            icon: "icon-hash",
          },
        }),
        gatewayEnvelope({ type: "GUILD_DELETE", data: { id: "guild-2", name: "Guild Two" } }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database.d1,
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
      }),
    );

    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"🟢 Bot Installed"/);
    assert.match(fetchCalls[0]?.body ?? "", /"value":"Guild One"/);
    assert.match(fetchCalls[0]?.body ?? "", /"nonce":"g:[A-Za-z0-9_-]{22}"/);
    assert.match(fetchCalls[0]?.body ?? "", /"enforce_nonce":true/);
    assert.match(
      fetchCalls[0]?.body ?? "",
      /"thumbnail":\{"url":"https:\/\/cdn\.discordapp\.com\/icons\/guild-1\/icon-hash\.png"\}/,
    );
    assert.match(fetchCalls[1]?.body ?? "", /"title":"⚠️ Bot Removed From Unknown Guild"/);
    assert.match(fetchCalls[1]?.body ?? "", /"value":"Guild Two"/);
  } finally {
    restore();
    database.close();
  }
});

test("processGatewayEventQueueMessages skips GUILD_CREATE for known guild without removal", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const database = new SqliteD1Database();
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          data: {
            id: "guild-1",
            name: "Guild One",
            member_count: 100,
            owner_id: "owner-1",
            icon: "icon-hash",
          },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);

    fetchCalls.length = 0;

    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          data: {
            id: "guild-1",
            name: "Guild One Updated",
            member_count: 150,
            owner_id: "owner-1",
            icon: "new-icon",
          },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 0);
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages suppresses standard bot events for active White-Label Bot Guilds", async () => {
  const database = new SqliteD1Database();
  const whiteLabelBots = createSqliteWhiteLabelBotStore(database as unknown as D1Database);
  await whiteLabelBots.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  const fetchCalls: string[] = [];
  const { restore } = interceptDiscordFetch(async (input) => {
    fetchCalls.push(String(input));
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          botIdentityId: "standard",
          botUserId: "bot-user-id",
          data: { id: "guild-1", name: "Guild One" },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.deepEqual(fetchCalls, []);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages allows standard bot events for suspended White-Label Bot Guilds", async () => {
  const database = new SqliteD1Database();
  const whiteLabelBots = createSqliteWhiteLabelBotStore(database as unknown as D1Database);
  await whiteLabelBots.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "suspended",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  const fetchCalls: string[] = [];
  const { restore } = interceptDiscordFetch(async (input) => {
    fetchCalls.push(String(input));
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          botIdentityId: "standard",
          botUserId: "bot-user-id",
          data: { id: "guild-1", name: "Guild One" },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages allows White-Label Bot events for active White-Label Bot Guilds", async () => {
  const database = new SqliteD1Database();
  const whiteLabelBots = createSqliteWhiteLabelBotStore(database as unknown as D1Database);
  await whiteLabelBots.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  const fetchCalls: string[] = [];
  const { restore } = interceptDiscordFetch(async (input) => {
    fetchCalls.push(String(input));
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          botIdentityId: "white-label:guild-1",
          botUserId: "white-label-bot-user",
          data: { id: "guild-1", name: "Guild One" },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
        WHITE_LABEL_BOT_GUILD_1_TOKEN: "white-label-token",
      }),
    );

    assert.equal(fetchCalls.length, 1);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages uses the standard bot token for standard Guild REST calls", async () => {
  const database = new SqliteD1Database();
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 100,
  });
  const authorizations: Array<string | null> = [];
  const { restore } = interceptDiscordFetch(async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return Response.json({ id: "message-1", channel_id: "audit-channel-1", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_UPDATE",
          botIdentityId: "standard",
          botUserId: "bot-user-id",
          data: {
            id: "message-1",
            guild_id: "guild-1",
            channel_id: "general-channel-1",
            content: "edited",
            author: { id: "user-1", username: "member" },
          },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(authorizations, ["Bot bot-token"]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages uses the White-Label Bot token for active White-Label Guild REST calls", async () => {
  const database = new SqliteD1Database();
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 100,
  });
  await createSqliteWhiteLabelBotStore(database as unknown as D1Database).upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  const authorizations: Array<string | null> = [];
  const { restore } = interceptDiscordFetch(async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    return Response.json({ id: "message-1", channel_id: "audit-channel-1", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "MESSAGE_UPDATE",
          botIdentityId: "white-label:guild-1",
          botUserId: "white-label-bot-user",
          data: {
            id: "message-1",
            guild_id: "guild-1",
            channel_id: "general-channel-1",
            content: "edited",
            author: { id: "user-1", username: "member" },
          },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        WHITE_LABEL_BOT_GUILD_1_TOKEN: "white-label-token",
      }),
    );

    assert.deepEqual(authorizations, ["Bot white-label-token"]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages rejects missing White-Label Bot token bindings", async () => {
  const database = new SqliteD1Database();
  await createSqliteGuildAuditLogStore(database as unknown as D1Database).upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: {} },
    updatedAtMs: 100,
  });
  await createSqliteWhiteLabelBotStore(database as unknown as D1Database).upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });

  await assert.rejects(
    () =>
      processGatewayEventQueueMessages(
        [
          gatewayEnvelope({
            type: "MESSAGE_UPDATE",
            botIdentityId: "white-label:guild-1",
            botUserId: "white-label-bot-user",
            data: {
              id: "message-1",
              guild_id: "guild-1",
              channel_id: "general-channel-1",
              content: "edited",
              author: { id: "user-1", username: "member" },
            },
          }),
        ],
        createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
      ),
    /WHITE_LABEL_BOT_GUILD_1_TOKEN is not configured/,
  );
});

test("processGatewayEventQueueMessages rejects wrong White-Label Bot gateway contexts", async () => {
  const database = new SqliteD1Database();
  await createSqliteWhiteLabelBotStore(database as unknown as D1Database).upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "white-label-bot-user",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_GUILD_1_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });

  await assert.rejects(
    () =>
      processGatewayEventQueueMessages(
        [
          gatewayEnvelope({
            type: "MESSAGE_UPDATE",
            botIdentityId: "white-label:guild-1",
            botUserId: "other-bot-user",
            data: {
              id: "message-1",
              guild_id: "guild-1",
              channel_id: "general-channel-1",
              content: "edited",
              author: { id: "user-1", username: "member" },
            },
          }),
        ],
        createGatewayConsumerEnv({
          HAF_DB: database as unknown as D1Database,
          WHITE_LABEL_BOT_GUILD_1_TOKEN: "white-label-token",
        }),
      ),
    /does not match the active bot user/,
  );
});

test("processGatewayEventQueueMessages sends install embed for re-added guild after removal", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const database = new SqliteD1Database();
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          data: {
            id: "guild-1",
            name: "Guild One",
            member_count: 100,
            owner_id: "owner-1",
            icon: "icon-hash",
          },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"🟢 Bot Installed"/);

    fetchCalls.length = 0;

    await processGatewayEventQueueMessages(
      [gatewayEnvelope({ type: "GUILD_DELETE", data: { id: "guild-1", name: "Guild One" } })],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"🔴 Bot Removed"/);

    fetchCalls.length = 0;

    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_CREATE",
          data: {
            id: "guild-1",
            name: "Guild One",
            member_count: 200,
            owner_id: "owner-1",
            icon: "icon-hash",
          },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"🟢 Bot Installed"/);
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages sends warning for removal of unknown guild", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const fetchCalls: Array<{ input: string; method: string | undefined; body: string | undefined }> =
    [];
  const database = new SqliteD1Database();
  const { restore } = interceptDiscordFetch(async (input, init) => {
    fetchCalls.push({
      input: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json({ id: "message-1", channel_id: "global-admin-log-channel", content: "" });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_DELETE",
          data: { id: "guild-unknown", name: "Unknown Guild" },
        }),
      ],
      createGatewayConsumerEnv({
        GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel",
        HAF_DB: database as unknown as D1Database,
      }),
    );

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]?.body ?? "", /"title":"⚠️ Bot Removed From Unknown Guild"/);
    assert.match(fetchCalls[0]?.body ?? "", /"value":"Unknown Guild"/);
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages creates one manual timed-role assignment from member updates", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const database = new SqliteD1Database();
  const timedRoleStore = createSqliteTimedRoleStore(database as unknown as D1Database);
  await timedRoleStore.upsertTimedRoleConfigRules?.("guild-1", "manual-assignment", [
    { roleId: "role-timeout", durationInput: "2h" },
  ]);
  const { restore } = interceptDiscordFetch(async () => new Response(null, { status: 204 }));

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_UPDATE",
          data: {
            guild_id: "guild-1",
            nick: "Fresh Spawn",
            user: { id: "user-1", username: "freshspawn", global_name: "Fresh Spawn" },
            roles: ["role-timeout"],
          },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_UPDATE",
          data: {
            guild_id: "guild-1",
            nick: "Fresh Spawn",
            user: { id: "user-1", username: "freshspawn", global_name: "Fresh Spawn" },
            roles: ["role-timeout"],
          },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        moderationStoreFetch(input: Request | string | URL, init?: RequestInit) {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (method === "GET" && url.pathname === "/timed-role/manual-assignment-config") {
            return Response.json({ roleId: "role-timeout", durationInput: "2h" });
          }
          return Response.json({ ok: true });
        },
      }),
    );

    assert.deepEqual(await timedRoleStore.listTimedRolesByGuild("guild-1"), [
      {
        guildId: "guild-1",
        userId: "user-1",
        roleId: "role-timeout",
        targetDisplayName: "Fresh Spawn",
        durationInput: "2h",
        expiresAtMs: 1_700_007_200_000,
      },
    ]);
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages creates a timed role for new members with a display name snapshot", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const database = new SqliteD1Database();
  const timedRoleStore = createSqliteTimedRoleStore(database as unknown as D1Database);
  await timedRoleStore.upsertTimedRoleConfigRules?.("guild-1", "new-member", [
    { roleId: "role-newbie", durationInput: "2h" },
  ]);
  const { restore } = interceptDiscordFetch(async () => new Response(null, { status: 204 }));

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: {
            guild_id: "guild-1",
            nick: "Fresh Spawn",
            user: { id: "user-1", username: "freshspawn", global_name: "Fresh Spawn" },
          },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        moderationStoreFetch(input: Request | string | URL, init?: RequestInit) {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (method === "GET" && url.pathname === "/timed-role/new-member-config") {
            return Response.json({ roleId: "role-newbie", durationInput: "2h" });
          }
          return Response.json({ ok: true });
        },
      }),
    );

    assert.deepEqual(await timedRoleStore.listTimedRolesByGuild("guild-1"), [
      {
        guildId: "guild-1",
        userId: "user-1",
        roleId: "role-newbie",
        targetDisplayName: "Fresh Spawn",
        durationInput: "2h",
        expiresAtMs: 1_700_007_200_000,
      },
    ]);
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages restores active timed roles for a rejoining member", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const database = new SqliteD1Database();
  const timedRoleStore = createSqliteTimedRoleStore(database as unknown as D1Database);
  await timedRoleStore.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-timeout",
    durationInput: "2h",
    expiresAtMs: 1_700_007_200_000,
  });
  await timedRoleStore.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-expired",
    durationInput: "1h",
    expiresAtMs: 1_699_999_999_999,
  });
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") {
      assignedRoles.push(String(input).split("/").at(-1) ?? "");
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: {
            guild_id: "guild-1",
            user: { id: "user-1", username: "returningmember" },
          },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignedRoles, ["role-timeout"]);
    const assignments = await timedRoleStore.listTimedRolesByGuild("guild-1");
    assert.equal(assignments.length, 2);
    assert.equal(
      assignments.find((assignment) => assignment.roleId === "role-timeout")?.expiresAtMs,
      1_700_007_200_000,
    );
    assert.equal(
      assignments.find((assignment) => assignment.roleId === "role-expired")?.expiresAtMs,
      1_699_999_999_999,
    );
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages does not refresh a restored timed role from new-member automation", async () => {
  const clock = mockDateNow(1_700_000_000_000);
  const database = new SqliteD1Database();
  const timedRoleStore = createSqliteTimedRoleStore(database as unknown as D1Database);
  await timedRoleStore.upsertTimedRoleConfigRules?.("guild-1", "new-member", [
    { roleId: "role-newbie", durationInput: "2h" },
  ]);
  await timedRoleStore.upsertTimedRole({
    guildId: "guild-1",
    userId: "user-1",
    roleId: "role-newbie",
    durationInput: "2h",
    expiresAtMs: 1_700_003_600_000,
  });
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") {
      assignedRoles.push(String(input).split("/").at(-1) ?? "");
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-1", username: "returningmember" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignedRoles, ["role-newbie"]);
    assert.equal(
      (await timedRoleStore.listTimedRolesByGuild("guild-1")).find(
        (assignment) => assignment.roleId === "role-newbie",
      )?.expiresAtMs,
      1_700_003_600_000,
    );
  } finally {
    restore();
    clock.restore();
  }
});

test("processGatewayEventQueueMessages restores unique linked roles for a rejoining member", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  const steamLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "steam", linkedRoleId: "role-linked" }),
  );
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "xbox", linkedRoleId: "role-xbox" }),
  );
  await steamLinkStore.upsertPlatformLinkConfig(
    createCurrentSteamConfig({ linkedRoleId: "role-linked" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ platform: "steam", platformId: "steam-modern" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ platform: "xbox", platformId: "xbox-1", linkedAtMs: 200 }),
  );
  await steamLinkStore.upsertPlatformLink(
    createCurrentSteamLink({ platformId: "steam-legacy", linkedAtMs: 300 }),
  );
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") {
      assignedRoles.push(String(input).split("/").at(-1) ?? "");
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: {
            guild_id: "guild-1",
            user: { id: "user-1", username: "linkedmember" },
          },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignedRoles, ["role-linked", "role-xbox"]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages requires a configured link to be relinked after rejoin", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({
      platform: "steam",
      linkedRoleId: "role-linked",
      requireRelinkOnRejoin: true,
    }),
  );
  await platformLinkStore.upsertPlatformLink(createPlatformLink());
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") assignedRoles.push(String(input).split("/").at(-1) ?? "");
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_REMOVE",
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.equal(
      (await platformLinkStore.readPlatformLink("guild-1", "user-1", "steam"))?.active,
      false,
    );
    assert.deepEqual(assignedRoles, []);
  } finally {
    restore();
  }
});

test("member departure checkpoints Server XP at the Gateway boundary", async () => {
  const database = new SqliteD1Database();
  const d1 = database as unknown as D1Database;
  const platformLinks = createSqlitePlatformLinkStore(d1);
  const serverLevels = createSqliteServerLevelStore(d1);
  const plans = createSqliteGuildPlanProjectionStore(d1);
  await plans.upsertGuildPlanProjection({ guildId: "guild-1", plan: "premium", updatedAtMs: 1 });
  await serverLevels.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    announcementChannelId: null,
    removedAtMs: null,
    updatedAtMs: 1,
  });
  await serverLevels.createConfiguredGameServer({
    id: "server-1",
    guildId: "guild-1",
    displayName: "DayZ",
    providerServerId: "cftools-1",
    maxSlots: 4,
    endpointId: "endpoint-1",
    webhookCredentialId: "credential-1",
    webhookVerifiedAtMs: 1,
    subscribedEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
    capacityProposal: null,
    lastRosterReconciledAtMs: null,
    lastCapacityCheckedAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await platformLinks.upsertPlatformLink(
    createPlatformLink({ platformId: "76561198000000001", active: true }),
  );
  await serverLevels.upsertProcessingCursor({
    configuredGameServerId: "server-1",
    latestSeenAtMs: 1_000,
    watermarkAtMs: 1_000,
    lastDeliveryId: "join",
    population: 1,
    queueSize: 0,
    lifecycleGeneration: 0,
    updatedAtMs: 1_000,
  });
  await serverLevels.upsertCurrentPresence({
    configuredGameServerId: "server-1",
    steamId64: "76561198000000001",
    lifecycleGeneration: 0,
    joinedAtMs: 1_000,
    lastConfirmedAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  await serverLevels.upsertEarningSession({
    sessionId: "session-1",
    guildId: "guild-1",
    configuredGameServerId: "server-1",
    steamId64: "76561198000000001",
    userId: "user-1",
    lifecycleGeneration: 0,
    startedAtMs: 1_000,
    lastConfirmedAtMs: 1_000,
    checkpointAtMs: 1_000,
    closedAtMs: null,
    closeReason: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  const { restore } = interceptDiscordFetch(async () => new Response(null, { status: 204 }));

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_REMOVE",
          receivedAtMs: 61_000,
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: d1 }),
    );

    assert.equal((await serverLevels.readProfile("guild-1", "user-1"))?.totalXpUnits, 240);
    assert.deepEqual(await serverLevels.listOpenEarningSessions("server-1"), []);
    assert.deepEqual(await serverLevels.listCurrentPresence("server-1"), []);
    assert.deepEqual(await serverLevels.listLeaderboard("guild-1", 10), []);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages retains legacy Steam fallback during verification", async () => {
  const database = new SqliteD1Database();
  const steamLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await steamLinkStore.upsertPlatformLinkConfig(
    createCurrentSteamConfig({ linkedRoleId: "role-legacy-steam" }),
  );
  await steamLinkStore.upsertPlatformLink(createCurrentSteamLink({ userId: "user-legacy" }));
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") {
      assignedRoles.push(String(input).split("/").at(-1) ?? "");
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-legacy", username: "legacy" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignedRoles, ["role-legacy-steam"]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages skips linked-role restore when no linked role applies", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  const steamLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "steam", linkedRoleId: null }),
  );
  await steamLinkStore.upsertPlatformLinkConfig(createCurrentSteamConfig({ linkedRoleId: null }));
  await platformLinkStore.upsertPlatformLink(createPlatformLink({ userId: "user-no-role" }));
  await steamLinkStore.upsertPlatformLink(createCurrentSteamLink({ userId: "user-no-role" }));
  const assignedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "PUT") {
      assignedRoles.push(String(input).split("/").at(-1) ?? "");
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-no-role" } },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-no-links" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignedRoles, []);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages skips missing linked roles without blocking other restores", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "xbox", linkedRoleId: "role-missing" }),
  );
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "playstation", linkedRoleId: "role-playstation" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ platform: "xbox", platformId: "xbox-missing" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ platform: "playstation", platformId: "psn-1", linkedAtMs: 200 }),
  );
  const attemptedRoles: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const roleId = String(input).split("/").at(-1) ?? "";
    if (init?.method === "PUT") {
      attemptedRoles.push(roleId);
    }
    return new Response(null, { status: roleId === "role-missing" ? 404 : 204 });
  });

  try {
    await assert.doesNotReject(() =>
      processGatewayEventQueueMessages(
        [
          gatewayEnvelope({
            type: "GUILD_MEMBER_ADD",
            data: { guild_id: "guild-1", user: { id: "user-1", username: "linkedmember" } },
          }),
        ],
        createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
      ),
    );

    assert.deepEqual(new Set(attemptedRoles), new Set(["role-missing", "role-playstation"]));
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages deduplicates linked roles per rejoining member", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "steam", linkedRoleId: "role-linked" }),
  );
  await platformLinkStore.upsertPlatformLinkConfig(
    createPlatformLinkConfig({ platform: "xbox", linkedRoleId: "role-linked" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ userId: "user-a", platform: "steam", platformId: "steam-a" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ userId: "user-a", platform: "xbox", platformId: "xbox-a" }),
  );
  await platformLinkStore.upsertPlatformLink(
    createPlatformLink({ userId: "user-b", platform: "steam", platformId: "steam-b" }),
  );
  const assignments: string[] = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const parts = String(input).split("/");
    if (init?.method === "PUT") {
      assignments.push(`${parts.at(-3)}:${parts.at(-1)}`);
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-a" } },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-b" } },
        }),
      ],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    );

    assert.deepEqual(assignments, ["user-a:role-linked", "user-b:role-linked"]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages sends a welcome DM to unverified new members", async () => {
  const database = new SqliteD1Database();
  const memberVerificationStore = createSqliteMemberVerificationStore(
    database as unknown as D1Database,
  );
  const entitlementStore = createSqliteGuildPlanProjectionStore(database as unknown as D1Database);
  await entitlementStore.upsertGuildPlanProjection({
    guildId: "guild-1",
    plan: "premium",
    updatedAtMs: Date.now(),
  });
  await memberVerificationStore.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    title: "Welcome",
    description: "Please verify to access the Guild.",
    color: 0x5865f2,
    imageUrl: null,
    thumbnailUrl: null,
    rulesUrl: null,
    verifyButtonEmoji: null,
    deliveryMode: "dm",
    verificationMethod: "discord-button",
    welcomeChannelId: null,
    panelMessageId: null,
    updatedAtMs: Date.now(),
  });

  const dmCalls: Array<{ userId: string; path: string; body: unknown }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const url = new URL(String(input));
    if (String(input).endsWith("/users/@me/channels")) {
      return Response.json({ id: "dm-channel-1" });
    }
    if (
      init?.method === "POST" &&
      url.pathname.startsWith("/api/v10/channels/") &&
      url.pathname.endsWith("/messages")
    ) {
      dmCalls.push({
        userId: url.pathname.split("/")[4] ?? "",
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ id: "dm-message-1" });
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        enableMemberVerification: true,
      }),
    );

    assert.equal(dmCalls.length, 1);
    assert.equal(dmCalls[0]?.userId, "dm-channel-1");
    assert.match(String((dmCalls[0]?.body as { nonce?: unknown })?.nonce), /^g:[A-Za-z0-9_-]{22}$/);
    assert.equal((dmCalls[0]?.body as { enforce_nonce?: unknown })?.enforce_nonce, true);
    assert.equal(
      (dmCalls[0]?.body as { components?: { components?: { custom_id?: string }[] }[] })
        ?.components?.[0]?.components?.[0]?.custom_id,
      buildMemberVerificationCustomId("guild-1"),
    );
  } finally {
    restore();
  }
});

test("replaying a member-add Gateway Event does not repeat its verified role grant", async () => {
  const database = new SqliteD1Database();
  const memberVerificationStore = createSqliteMemberVerificationStore(
    database as unknown as D1Database,
  );
  const entitlementStore = createSqliteGuildPlanProjectionStore(database as unknown as D1Database);
  await entitlementStore.upsertGuildPlanProjection({
    guildId: "guild-1",
    plan: "premium",
    updatedAtMs: Date.now(),
  });
  await memberVerificationStore.upsertConfig({
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "verified-role-1",
    title: "Welcome",
    description: "Please verify to access the Guild.",
    color: 0x5865f2,
    imageUrl: null,
    thumbnailUrl: null,
    rulesUrl: null,
    verifyButtonEmoji: null,
    deliveryMode: "dm",
    verificationMethod: "discord-button",
    welcomeChannelId: null,
    panelMessageId: null,
    updatedAtMs: Date.now(),
  });
  await memberVerificationStore.upsertVerificationState({
    guildId: "guild-1",
    userId: "user-1",
    verifiedAtMs: Date.now(),
  });

  const roleAssignments: Array<{ guildId: string; userId: string; roleId: string }> = [];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT" && url.pathname.startsWith("/api/v10/guilds/")) {
      const parts = url.pathname.split("/");
      roleAssignments.push({
        guildId: parts[4] ?? "",
        userId: parts[6] ?? "",
        roleId: parts[8] ?? "",
      });
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
        gatewayEnvelope({
          type: "GUILD_MEMBER_ADD",
          data: { guild_id: "guild-1", user: { id: "user-1" } },
        }),
      ],
      createGatewayConsumerEnv({
        HAF_DB: database as unknown as D1Database,
        enableMemberVerification: true,
      }),
    );

    assert.deepEqual(roleAssignments, [
      { guildId: "guild-1", userId: "user-1", roleId: "verified-role-1" },
    ]);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages deletes mapped LFG voice channels when they empty", async () => {
  const deletedChannels: string[] = [];
  const voiceChannels = [
    {
      guildId: "guild-1",
      postId: "post-1",
      channelId: "voice-channel-1",
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ];
  const { restore } = interceptDiscordFetch(async (input, init) => {
    if (init?.method === "DELETE") {
      deletedChannels.push(String(input));
    }
    return new Response(null, { status: 204 });
  });

  try {
    await processGatewayEventQueueMessages(
      [
        gatewayEnvelope({
          type: "VOICE_STATE_UPDATE",
          data: { guild_id: "guild-1", user_id: "user-1", channel_id: null },
          emptiedVoiceChannelId: "voice-channel-1",
        }),
      ],
      createGatewayConsumerEnv({
        moderationStoreFetch(input: Request | string | URL, init?: RequestInit) {
          const url = new URL(String(input));
          const method = init?.method ?? "GET";
          if (method === "GET" && url.pathname === "/lfg/voice-channel/by-channel-id") {
            return Response.json(
              voiceChannels.find(
                (channel) => channel.channelId === url.searchParams.get("channelId"),
              ) ?? null,
            );
          }
          if (method === "POST" && url.pathname === "/lfg/voice-channel/delete") {
            const body = JSON.parse(String(init?.body)) as { guildId: string; postId: string };
            const index = voiceChannels.findIndex(
              (channel) => channel.guildId === body.guildId && channel.postId === body.postId,
            );
            if (index >= 0) voiceChannels.splice(index, 1);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        },
      }),
    );

    assert.deepEqual(deletedChannels, ["https://discord.com/api/v10/channels/voice-channel-1"]);
    assert.deepEqual(voiceChannels, []);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages skips malformed messages and continues", async () => {
  const errors: unknown[] = [];
  const fetchCalls: unknown[] = [];
  const { restore } = interceptDiscordFetch(async (input) => {
    fetchCalls.push(String(input));
    return Response.json({ ok: true });
  });

  try {
    await assert.doesNotReject(() =>
      processGatewayEventQueueMessages(
        [
          null,
          gatewayEnvelope({ type: "GUILD_CREATE", data: { id: "guild-1", name: "Guild One" } }),
        ],
        createGatewayConsumerEnv({ GLOBAL_ADMIN_LOG_CHANNEL_ID: "global-admin-log-channel" }),
        { error: (...args: unknown[]) => errors.push(args) },
      ),
    );

    assert.equal(errors.length, 1);
    assert.equal(fetchCalls.length, 1);
  } finally {
    restore();
  }
});

test("processGatewayEventQueueMessages rejects processing failures so queues retry", async () => {
  const errors: unknown[] = [];
  const appDb = {
    async exec() {
      return { count: 0, duration: 0 } as never;
    },
    prepare() {
      throw Object.assign(new Error("store unavailable"), { code: "ECONNREFUSED" });
    },
  } as unknown as D1Database;

  await assert.rejects(
    () =>
      processGatewayEventQueueMessages(
        [
          gatewayEnvelope({
            type: "MESSAGE_UPDATE",
            data: {
              id: "message-9",
              channel_id: "channel-9",
              guild_id: "guild-1",
              content: "updated ticket reply",
            },
          }),
        ],
        createGatewayConsumerEnv({ HAF_DB: appDb }),
        { error: (...args: unknown[]) => errors.push(args) },
      ),
    /store unavailable/,
  );

  assert.equal(errors.length, 1);
});

test("Gateway Event consumer settles successful and malformed siblings before retrying a database failure", async () => {
  const appDb = {
    async exec() {
      return { count: 0, duration: 0 } as never;
    },
    prepare() {
      throw Object.assign(new Error("store unavailable"), { code: "ECONNREFUSED" });
    },
  } as unknown as D1Database;
  const complete = fakeQueueMessage(
    "complete",
    gatewayEnvelope({ type: "UNHANDLED_EVENT", data: {} }),
  );
  const retry = fakeQueueMessage(
    "retry",
    gatewayEnvelope({
      type: "MESSAGE_UPDATE",
      data: {
        id: "message-9",
        channel_id: "channel-9",
        guild_id: "guild-1",
        content: "updated ticket reply",
      },
    }),
  );
  const malformed = fakeQueueMessage("malformed", null);
  const events: Array<{ reasonCode?: string }> = [];

  await deliverGatewayEventQueueBatch(
    fakeGatewayBatch([complete, retry, malformed]),
    createGatewayConsumerEnv({ HAF_DB: appDb }),
    {
      error() {},
      info(_message, event) {
        events.push(event as { reasonCode?: string });
      },
    },
  );

  assert.deepEqual(complete.actions, ["ack"]);
  assert.deepEqual(retry.actions, ["retry"]);
  assert.deepEqual(malformed.actions, ["ack"]);
  assert.equal(
    events.find((event) => event.reasonCode === "database_unavailable")?.reasonCode,
    "database_unavailable",
  );
});

test("Gateway Event consumer terminally rejects unsupported envelope versions", async () => {
  const unsupported = fakeQueueMessage("unsupported", {
    version: 99,
    eventKey: "future-event",
    type: "MESSAGE_CREATE",
    data: {},
  });
  const events: Array<{ event?: string; reasonCode?: string }> = [];

  await deliverGatewayEventQueueBatch(fakeGatewayBatch([unsupported]), createGatewayConsumerEnv(), {
    error() {},
    info(_message, event) {
      events.push(event as { event?: string; reasonCode?: string });
    },
  });

  assert.deepEqual(unsupported.actions, ["ack"]);
  assert.equal(events.at(-1)?.event, "terminal");
  assert.equal(events.at(-1)?.reasonCode, "unsupported_gateway_event_version");
});

for (const audit of [
  { type: "MESSAGE_UPDATE", handlerKey: "message-update:audit-post" },
  { type: "GUILD_BAN_ADD", handlerKey: "ban:member.ban:audit-post" },
  { type: "CHANNEL_CREATE", handlerKey: "channel:guild-structure.channel-create:audit-post" },
]) {
  for (const status of [429, 503]) {
    test(`Gateway ${audit.type} audit retries HTTP ${status}, reports once, and completes without duplicate posts`, async () => {
      const database = new SqliteD1Database();
      const clock = mockDateNow(1_800_000_000_000);
      const env = createGatewayConsumerEnv({ HAF_DB: database.d1 });
      const envelope = gatewayEnvelope({
        type: audit.type,
        data: {
          id: "message-1",
          guild_id: "guild-1",
          channel_id: "general-channel-1",
          content: "edited",
          author: { id: "user-1" },
          user: { id: "user-1" },
          name: "general",
          type: 0,
        },
      });
      const eventKey = deriveGatewayEventKey(envelope);
      const receipts = createGatewayEventOperationStore(database.d1);
      const posts: Array<{ nonce?: string; enforce_nonce?: boolean }> = [];
      const errors: unknown[][] = [];
      const warnings: unknown[][] = [];
      const originalError = console.error;
      const originalWarn = console.warn;
      console.error = (...args) => {
        errors.push(args);
      };
      console.warn = (...args) => {
        warnings.push(args);
      };
      const { restore } = interceptDiscordFetch(async (input, init) => {
        assert.match(String(input), /\/channels\/audit-channel-1\/messages$/);
        posts.push(JSON.parse(String(init?.body)));
        if (posts.length === 1) {
          return Response.json(
            status === 429
              ? { message: "You are being rate limited.", retry_after: 1.25, global: false }
              : { message: "Service unavailable" },
            { status },
          );
        }
        return Response.json({ id: "audit-message-1", channel_id: "audit-channel-1" });
      });
      try {
        await createSqliteGuildAuditLogStore(database.d1).upsertConfig({
          guildId: "guild-1",
          auditChannelId: "audit-channel-1",
          groupChannelIds: {},
          eventStates: { groups: {}, overrides: {} },
          updatedAtMs: Date.now(),
        });
        const first = fakeQueueMessage("first", envelope);
        const delays: Array<number | undefined> = [];
        first.retry = (options?: { delaySeconds?: number }) => {
          delays.push(options?.delaySeconds);
          return first.actions.push("retry");
        };
        const deliver = (message: ReturnType<typeof fakeQueueMessage>) =>
          deliverGatewayEventQueueBatch(
            fakeGatewayBatch([message]),
            env,
            { error() {}, info() {} },
            {
              guildResources: createPermissiveGuildResourceValidator(),
            },
          );
        await deliver(first);
        assert.deepEqual(first.actions, ["retry"]);
        assert.deepEqual(delays, [120]);
        const reports = [...warnings, ...errors];
        assert.equal(reports.length, 1);
        assert.equal(
          (reports[0][0] as { code: string }).code,
          status === 429 ? "queue.provider_rate_limited" : "queue.provider_unavailable",
        );
        assert.equal(errors.length, status === 429 ? 0 : 1);
        const receipt = await receipts.read(eventKey, audit.handlerKey);
        assert.equal(receipt?.state, "processing");
        assert.notEqual(receipt?.leaseExpiresAtMs, null);
        clock.set(Date.now() + delays[0]! * 1_000);
        const redelivery = fakeQueueMessage("redelivery", envelope);
        redelivery.attempts = 2;
        await deliver(redelivery);
        assert.deepEqual(redelivery.actions, ["ack"]);
        assert.equal((await receipts.read(eventKey, audit.handlerKey))?.state, "completed");
        const replay = fakeQueueMessage("replay", envelope);
        await deliver(replay);
        assert.deepEqual(replay.actions, ["ack"]);
        assert.equal(posts.length, 2);
        assert.ok(posts[0].nonce);
        assert.equal(posts[0].nonce, posts[1].nonce);
        assert.equal(posts[1].enforce_nonce, true);
        assert.equal(warnings.length + errors.length, 1);
      } finally {
        restore();
        console.error = originalError;
        console.warn = originalWarn;
        clock.restore();
        database.close();
      }
    });
  }
}

test("Gateway Event consumer rejects unverified or unsafe v2 event keys", async () => {
  const unsafe = fakeQueueMessage("unsafe", {
    version: 2,
    eventKey: "https://discord.com/api/webhooks/123/secret-token",
    sessionId: "session-1",
    sequence: 1,
    type: "MESSAGE_CREATE",
    data: {},
  });
  const oversized = fakeQueueMessage("oversized", {
    version: 2,
    eventKey: `v2:${"a".repeat(500)}`,
    sessionId: "session-1",
    sequence: 2,
    type: "MESSAGE_CREATE",
    data: {},
  });
  const events: Array<{ event?: string; reasonCode?: string }> = [];

  await deliverGatewayEventQueueBatch(
    fakeGatewayBatch([unsafe, oversized]),
    createGatewayConsumerEnv(),
    {
      error() {},
      info(_message, event) {
        events.push(event as { event?: string; reasonCode?: string });
      },
    },
  );

  assert.deepEqual(unsafe.actions, ["ack"]);
  assert.deepEqual(oversized.actions, ["ack"]);
  assert.deepEqual(
    events.filter((event) => event.event === "terminal").map((event) => event.reasonCode),
    ["invalid_gateway_event_key", "invalid_gateway_event_key"],
  );
});

test("Gateway Event consumer preserves a terminal inner operation on replay", async () => {
  const database = new SqliteD1Database();
  const envelope = gatewayEnvelope({
    type: "MESSAGE_UPDATE",
    data: {
      id: "message-terminal",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "updated",
    },
  });
  const eventKey = deriveGatewayEventKey(envelope);
  const store = createGatewayEventOperationStore(database as unknown as D1Database);
  const claim = await store.claim(eventKey, "message-update:audit-post", 1_000, 100);
  assert.equal(claim.status, "acquired");
  if (claim.status !== "acquired") throw new Error("expected lease");
  await store.terminal(
    claim.leaseToken,
    eventKey,
    "message-update:audit-post",
    1_001,
    "invalid_audit_payload",
  );

  await assert.rejects(
    processGatewayEventQueueMessages(
      [envelope],
      createGatewayConsumerEnv({ HAF_DB: database as unknown as D1Database }),
    ),
    /invalid_audit_payload/,
  );
  assert.equal((await store.read(eventKey, "event:dispatch"))?.state, "terminal");
});

function fakeQueueMessage(id: string, body: unknown) {
  const actions: string[] = [];
  return {
    id,
    body,
    attempts: 1,
    timestamp: new Date(),
    actions,
    ack: () => actions.push("ack"),
    retry: () => actions.push("retry"),
  };
}

function fakeGatewayBatch(messages: ReturnType<typeof fakeQueueMessage>[]): QueueBatch<unknown> {
  return {
    queue: "haf-bot-gateway-events",
    messages,
    ackAll() {},
    retryAll() {},
  };
}

function interceptDiscordFetch(handler: typeof fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://community-store/")) {
      return originalFetch(input, init);
    }
    return handler(input, init);
  };

  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function createGatewayConsumerEnv(options?: {
  GLOBAL_ADMIN_LOG_CHANNEL_ID?: string;
  HAF_DB?: D1Database;
  moderationStoreFetch?: (input: Request | string | URL, init?: RequestInit) => Response;
  WHITE_LABEL_BOT_GUILD_1_TOKEN?: string;
  enableMemberVerification?: boolean;
  enableMentionProtection?: boolean;
  componentIdSigningSecret?: string;
}) {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    WHITE_LABEL_BOT_GUILD_1_TOKEN: options?.WHITE_LABEL_BOT_GUILD_1_TOKEN,
    BOT_USER_ID: "bot-user-id",
    GLOBAL_ADMIN_LOG_CHANNEL_ID: options?.GLOBAL_ADMIN_LOG_CHANNEL_ID,
    DISABLE_MEMBER_VERIFICATION: options?.enableMemberVerification ? undefined : "true",
    DISABLE_MENTION_PROTECTION: options?.enableMentionProtection ? undefined : "true",
    COMPONENT_ID_SIGNING_SECRET: options?.componentIdSigningSecret,
    HAF_DB:
      options?.HAF_DB ??
      createLegacyCommunityStoreDatabase({ moderationFetch: options?.moderationStoreFetch }),
  } as never;
}

function mockDateNow(now: number) {
  let current = now;
  const originalNow = Date.now;
  Date.now = () => current;

  return {
    set(value: number) {
      current = value;
    },
    restore() {
      Date.now = originalNow;
    },
  };
}

function createPlatformLinkConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your account",
    panelDescription: "Click the button below to securely link your Discord account.",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createPlatformLink(overrides: Partial<PlatformLink> = {}): PlatformLink {
  return {
    guildId: "guild-1",
    userId: "user-1",
    platform: "steam",
    platformId: "76561198000000000",
    linkedAtMs: 100,
    manual: false,
    actionedByUserId: null,
    metadataJson: null,
    active: true,
    ...overrides,
  };
}

function createCurrentSteamConfig(overrides: Partial<PlatformLinkConfig> = {}): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link your Steam account",
    panelDescription:
      "Click the button below to securely link your Discord account to your Steam account.",
    panelButtonLabel: "Link Steam",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function createCurrentSteamLink(overrides: Partial<PlatformLink> = {}): PlatformLink {
  return {
    guildId: "guild-1",
    platform: "steam",
    userId: "user-1",
    platformId: "76561198000000000",
    linkedAtMs: 100,
    manual: false,
    actionedByUserId: null,
    metadataJson: "[]",
    active: true,
    ...overrides,
  };
}
