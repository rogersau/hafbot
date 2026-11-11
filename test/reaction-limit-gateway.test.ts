import { gatewayEnvelope } from "./support/gateway-envelope";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { processGatewayEventQueueMessages } from "./support/gateway-event-consumer";
import { SqliteD1Database } from "./support/sqlite-d1-database";

for (const isBot of [false, true]) {
  test(`processGatewayEventQueueMessages enforces reaction limits for ${isBot ? "bots without DMs" : "members with DMs"}`, async () => {
    const clock = mockDateNow(1_700_000_000_000);
    const discordCalls: Array<{ input: string; method: string; body?: string }> = [];
    const database = createReactionLimitDatabase();
    const { restore } = interceptDiscordFetch(async (input, init) => {
      discordCalls.push({
        input: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      if (String(input).endsWith("/users/@me/channels")) {
        return Response.json({ id: "dm-channel-1" });
      }

      return Response.json({ ok: true });
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
              ...(isBot ? { member: { user: { id: "user-1", bot: true } } } : {}),
            },
          }),
        ],
        createEnv(database as unknown as D1Database),
      );
    } finally {
      restore();
      clock.restore();
    }

    assert.equal(
      discordCalls.some((call) => call.method === "DELETE"),
      true,
    );
    assert.equal(
      discordCalls.some((call) => call.method === "GET"),
      false,
    );
    assert.equal(
      discordCalls.some((call) => call.input.endsWith("/users/@me/channels")),
      !isBot,
    );
    assert.equal(
      discordCalls.some((call) => call.input.includes("/roles/role-1")),
      true,
    );

    const dmCall = discordCalls.find(
      (call) => call.method === "POST" && call.input.endsWith("/channels/dm-channel-1/messages"),
    );
    if (isBot) {
      assert.equal(dmCall, undefined);
    } else {
      assert.ok(dmCall?.body);
      assert.deepEqual(JSON.parse(dmCall.body), {
        content: "Reaction limit breached.",
        allowed_mentions: { parse: [] },
        nonce: "g:RJc7y-4JYri-itCdt4Wy1g",
        enforce_nonce: true,
      });
    }
    assert.deepEqual(await readBreachCounters(database), []);
    assert.deepEqual(await readTimedRoles(database), [
      {
        guild_id: "guild-1",
        user_id: "user-1",
        role_id: "role-1",
        target_display_name: null,
        duration_input: "60000ms",
        expires_at_ms: 1_700_000_060_000,
        created_at_ms: 1_700_000_000_000,
        updated_at_ms: 1_700_000_000_000,
      },
    ]);

    const notificationCall = discordCalls.find(
      (call) =>
        call.method === "POST" && call.input.endsWith("/channels/notification-channel-1/messages"),
    );
    assert.ok(notificationCall?.body);
    const notificationBody = JSON.parse(notificationCall.body) as {
      content?: string;
      embeds?: Array<{
        title?: string;
        color?: number;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        footer?: { text: string };
        timestamp?: string;
      }>;
      allowed_mentions?: { parse?: string[] };
    };

    assert.equal(notificationBody.content, undefined);
    assert.deepEqual(notificationBody.allowed_mentions, { parse: [] });
    assert.equal(notificationBody.embeds?.length, 1);
    assert.equal(notificationBody.embeds?.[0]?.title, "Reaction Limit Breach");
    assert.equal(notificationBody.embeds?.[0]?.color, 0xed4245);
    assert.deepEqual(notificationBody.embeds?.[0]?.footer, { text: "hafbot.xyz" });
    assert.match(notificationBody.embeds?.[0]?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(notificationBody.embeds?.[0]?.fields, [
      { name: "Breaching Member", value: "<@user-1>\nID: user-1", inline: false },
      { name: "Assigned Role", value: "<@&role-1>", inline: false },
      {
        name: "Breach Context",
        value:
          "Channel: <#channel-1>\nMessage ID: message-1\nBreach count: 1 / 1\nUser reactions: 2 / 1",
        inline: false,
      },
    ]);
  });
}

test("reaction-limit replay resumes after the breach boundary without incrementing twice", async () => {
  let nowMs = 1_700_000_000_000;
  const originalNow = Date.now;
  Date.now = () => nowMs;
  const database = createReactionLimitDatabase();
  let failAudit = true;
  const { restore } = interceptDiscordFetch(async (input) => {
    if (String(input).endsWith("/users/@me/channels")) {
      return Response.json({ id: "dm-channel-1" });
    }
    if (failAudit && String(input).endsWith("/channels/notification-channel-1/messages")) {
      return Response.json({ message: "temporary" }, { status: 500 });
    }
    return Response.json({ ok: true });
  });
  const event = gatewayEnvelope({
    type: "MESSAGE_REACTION_ADD",
    data: {
      channel_id: "channel-1",
      message_id: "message-1",
      guild_id: "guild-1",
      emoji: { id: null, name: "✅", animated: false },
      user_id: "user-1",
    },
  });

  try {
    await assert.rejects(
      processGatewayEventQueueMessages([event], createEnv(database as unknown as D1Database)),
    );
    const originalExpiry = ((await readTimedRoles(database))[0] as { expires_at_ms: number })
      .expires_at_ms;
    database
      .prepare(
        `DELETE FROM gateway_event_operations
         WHERE handler_key = 'reaction-add:reaction-limit:timed-role'`,
      )
      .run();
    failAudit = false;
    nowMs += 2 * 60 * 1_000 + 1;
    await processGatewayEventQueueMessages([event], createEnv(database as unknown as D1Database));
    assert.equal(
      ((await readTimedRoles(database))[0] as { expires_at_ms: number }).expires_at_ms,
      originalExpiry,
    );
  } finally {
    restore();
    Date.now = originalNow;
  }

  assert.deepEqual(await readReactionCounts(database), {
    total: 2,
    user: 2,
  });
});

function createReactionLimitDatabase(): SqliteD1Database {
  const database = new SqliteD1Database();
  database
    .prepare(
      "INSERT INTO reaction_limit_configs(guild_id, limits_enabled, max_reactions_per_message, max_reactions_per_user_per_message, breach_threshold, breach_role_id, breach_role_duration_ms, breach_dm_text, channel_mode, channel_ids_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "guild-1",
      1,
      null,
      1,
      1,
      "role-1",
      60_000,
      "Reaction limit breached.",
      "include",
      '["channel-1"]',
    )
    .run();
  database
    .prepare("INSERT INTO guild_entitlements(guild_id, plan, updated_at_ms) VALUES(?, ?, ?)")
    .bind("guild-1", "premium", 0)
    .run();
  database
    .prepare(
      "INSERT INTO guild_notification_channels(guild_id, feature, notification_channel_id) VALUES(?, ?, ?)",
    )
    .bind("guild-1", "blocklist", "notification-channel-1")
    .run();
  database
    .prepare(
      "INSERT INTO reaction_limit_message_reaction_counts(guild_id, channel_id, message_id, reaction_count) VALUES(?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-1", 1)
    .run();
  database
    .prepare(
      "INSERT INTO reaction_limit_user_message_reaction_counts(guild_id, channel_id, message_id, user_id, reaction_count) VALUES(?, ?, ?, ?, ?)",
    )
    .bind("guild-1", "channel-1", "message-1", "user-1", 1)
    .run();
  return database;
}

async function readBreachCounters(database: SqliteD1Database): Promise<unknown[]> {
  return (
    await database
      .prepare("SELECT guild_id, user_id, breach_count FROM reaction_limit_breach_counters")
      .all()
  ).results;
}

async function readTimedRoles(database: SqliteD1Database): Promise<unknown[]> {
  return (
    await database
      .prepare(
        "SELECT guild_id, user_id, role_id, target_display_name, duration_input, expires_at_ms, created_at_ms, updated_at_ms FROM timed_roles",
      )
      .all()
  ).results;
}

async function readReactionCounts(
  database: SqliteD1Database,
): Promise<{ total: number; user: number }> {
  const total = await database
    .prepare("SELECT reaction_count FROM reaction_limit_message_reaction_counts")
    .first<{ reaction_count: number }>();
  const user = await database
    .prepare("SELECT reaction_count FROM reaction_limit_user_message_reaction_counts")
    .first<{ reaction_count: number }>();
  return { total: total?.reaction_count ?? 0, user: user?.reaction_count ?? 0 };
}

function mockDateNow(nowMs: number) {
  const original = Date.now;
  Date.now = () => nowMs;
  return { restore: () => (Date.now = original) };
}

function interceptDiscordFetch(handler: typeof fetch) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return { restore: () => (globalThis.fetch = originalFetch) };
}

function createEnv(database: D1Database) {
  return {
    HAF_DB: database,
    BOT_USER_ID: "bot-1",
    DISCORD_BOT_TOKEN: "bot-token",
  } as never;
}
