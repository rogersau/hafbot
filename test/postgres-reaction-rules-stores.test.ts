import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresAppConfigStore } from "../src/runtime/postgres/postgres-app-config-store";
import { createPostgresBlocklistStore } from "../src/runtime/postgres/postgres-blocklist-store";
import {
  createPostgresDatabaseCapabilityFromEnvironment,
  type PostgresDatabaseCapability,
} from "../src/runtime/postgres/postgres-capability";
import { initializePostgresSchema } from "../src/runtime/postgres/postgres-schema";
import { createPostgresProductAnalyticsPreferenceStore } from "../src/runtime/postgres/postgres-product-analytics-preference-store";
import { createPostgresReactionLimitStore } from "../src/runtime/postgres/postgres-reaction-limit-store";
import { createPostgresReactionRoleStore } from "../src/runtime/postgres/postgres-reaction-role-store";
import type { ReactionLimitConfig } from "../src/types";

const postgresUrl = process.env.TEST_POSTGRES_URL;

test(
  "PostgreSQL Reaction Rules adapters preserve D1 behavior and atomic counters",
  { skip: postgresUrl ? false : "TEST_POSTGRES_URL is not configured" },
  async () => {
    assert.ok(postgresUrl);
    assertSafeTestDatabase(postgresUrl);
    const database = createPostgresDatabaseCapabilityFromEnvironment({
      DATABASE_URL: postgresUrl,
      NODE_ENV: "test",
      PG_POOL_MAX: "8",
    });
    try {
      await resetDatabase(database);
      await verifyBlocklistStore(database);
      await verifyProductAnalyticsPreferences(database);
      await verifyReactionLimits(database);
      await verifyReactionRolePanels(database);
    } finally {
      await database.close();
    }
  },
);

async function verifyBlocklistStore(database: PostgresDatabaseCapability): Promise<void> {
  const appConfig = createPostgresAppConfigStore(database);
  const store = createPostgresBlocklistStore(database, "bot-default");
  assert.deepEqual(await store.readConfig(), { botUserId: "bot-default", guilds: {} });

  await appConfig.upsertAppConfig({ key: "bot_user_id", value: "bot-from-db" });
  await store.applyGuildEmojiMutations({
    guildId: "guild-rules",
    emojis: ["🚫", "✅", "✅"],
    action: "add",
  });
  await store.upsertGuildChannelFilter({
    guildId: "guild-rules",
    channelMode: "exclude",
    channelIds: ["channel-1", "channel-2"],
  });
  await store.upsertGuildNotificationChannel({
    guildId: "guild-rules",
    feature: "timed_roles",
    notificationChannelId: "log-1",
  });

  assert.deepEqual(await store.readConfig(), {
    botUserId: "bot-from-db",
    guilds: {
      "guild-rules": {
        enabled: true,
        emojis: ["✅", "🚫"],
        channelMode: "exclude",
        channelIds: ["channel-1", "channel-2"],
      },
    },
  });
  assert.deepEqual(await store.readGuildConfig("guild-rules"), {
    botUserId: "bot-from-db",
    guilds: {
      "guild-rules": {
        enabled: true,
        emojis: ["✅", "🚫"],
        channelMode: "exclude",
        channelIds: ["channel-1", "channel-2"],
      },
    },
  });
  assert.equal(await store.readGuildNotificationChannel("guild-rules", "timed_roles"), "log-1");

  await Promise.all(
    Array.from({ length: 10 }, () =>
      store.applyGuildEmojiMutation({ guildId: "guild-rules", emoji: "🔥", action: "add" }),
    ),
  );
  assert.equal(
    (await store.readConfig()).guilds["guild-rules"]?.emojis.filter((emoji) => emoji === "🔥")
      .length,
    1,
  );

  await store.upsertGuildNotificationChannel({
    guildId: "guild-rules",
    feature: "timed_roles",
    notificationChannelId: null,
  });
  assert.equal(await store.readGuildNotificationChannel("guild-rules", "timed_roles"), null);
}

async function verifyProductAnalyticsPreferences(
  database: PostgresDatabaseCapability,
): Promise<void> {
  const store = createPostgresProductAnalyticsPreferenceStore(database);
  assert.equal(await store.readEnabled("guild-rules"), true);
  await store.setEnabled("guild-rules", false, 100);
  assert.equal(await store.readEnabled("guild-rules"), false);
  assert.equal(await store.readEnabled("guild-other"), true);
  await store.setEnabled("guild-rules", true, 200);
  assert.equal(await store.readEnabled("guild-rules"), true);
}

async function verifyReactionLimits(database: PostgresDatabaseCapability): Promise<void> {
  const store = createPostgresReactionLimitStore(database);
  const config: ReactionLimitConfig = {
    guildId: "guild-rules",
    limitsEnabled: true,
    maxReactionsPerMessage: 10,
    maxReactionsPerUserPerMessage: 3,
    breachThreshold: 2,
    breachRoleId: "role-1",
    breachRoleDurationMs: 7_200_000_000,
    breachDmText: "Please slow down with reactions.",
    channelMode: "exclude",
    channelIds: ["channel-1"],
  };
  assert.equal(await store.readReactionLimitConfig(config.guildId), null);
  await store.upsertReactionLimitConfig(config);
  assert.deepEqual(await store.readReactionLimitConfig(config.guildId), config);

  const breachValues = await Promise.all(
    Array.from({ length: 25 }, () => store.incrementBreachCounter(config.guildId, "user-1")),
  );
  assert.deepEqual(
    [...breachValues].sort((left, right) => left - right),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.deepEqual(await store.readBreachCounters(config.guildId), [
    { guildId: config.guildId, userId: "user-1", breachCount: 25 },
  ]);

  const messageValues = await Promise.all(
    Array.from({ length: 20 }, () =>
      store.incrementMessageReactionCount(config.guildId, "channel-1", "message-1"),
    ),
  );
  assert.deepEqual(
    [...messageValues].sort((left, right) => left - right),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  const userMessageValues = await Promise.all(
    Array.from({ length: 20 }, () =>
      store.incrementUserMessageReactionCount(config.guildId, "channel-1", "message-1", "user-1"),
    ),
  );
  assert.deepEqual(
    [...userMessageValues].sort((left, right) => left - right),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  await store.incrementMessageReactionCount(config.guildId, "channel-1", "message-0");
  await store.incrementUserMessageReactionCount(config.guildId, "channel-1", "message-0", "user-1");
  await database.execute(`UPDATE reaction_limit_message_reaction_counts
                          SET updated_at_ms = CASE message_id
                            WHEN 'message-0' THEN 500
                            WHEN 'message-1' THEN 1000
                            ELSE updated_at_ms
                          END`);
  await database.execute(`UPDATE reaction_limit_user_message_reaction_counts
                          SET updated_at_ms = CASE message_id
                            WHEN 'message-0' THEN 500
                            WHEN 'message-1' THEN 1000
                            ELSE updated_at_ms
                          END`);
  await store.incrementMessageReactionCount(config.guildId, "channel-1", "message-2");
  await store.incrementUserMessageReactionCount(config.guildId, "channel-1", "message-2", "user-1");
  assert.equal(await store.purgeExpiredCounters(1500, 1), 2);
  assert.equal(await store.purgeExpiredCounters(1500, 1), 2);
  assert.deepEqual(
    await database.query<{ message_id: string }>(
      "SELECT message_id FROM reaction_limit_message_reaction_counts ORDER BY message_id",
    ),
    [{ message_id: "message-2" }],
  );
  assert.deepEqual(
    await database.query<{ message_id: string }>(
      "SELECT message_id FROM reaction_limit_user_message_reaction_counts ORDER BY message_id",
    ),
    [{ message_id: "message-2" }],
  );

  await store.resetBreachCounter(config.guildId, "user-1");
  assert.deepEqual(await store.readBreachCounters(config.guildId), []);
}

async function resetDatabase(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
}

async function verifyReactionRolePanels(database: PostgresDatabaseCapability): Promise<void> {
  await database.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await initializePostgresSchema(database);
  const options = [{ emoji: "🟢", roleId: "300", label: "DayZ" }];
  const store = createPostgresReactionRoleStore(database);
  assert.equal(await store.claimLease("100", "current", 100), true);
  const main = {
    guildId: "100",
    id: "main",
    botUserId: "900",
    channelId: "200",
    messageId: "500",
    title: "Games",
    description: "Choose a game",
    options,
    publishedOptions: options,
    activatedAtMs: 1,
    enabled: true,
    updatedAtMs: 1,
    mode: "multiple" as const,
    requiredRoleIds: [],
    blockedRoleIds: [],
  };
  assert.equal(await store.savePanel(main, { token: "current", nowMs: 100 }), true);
  const extra = {
    ...main,
    id: "regions",
    messageId: "501",
    title: "Regions",
    mode: "single" as const,
    requiredRoleIds: ["410"],
    blockedRoleIds: ["411"],
    options: [{ emoji: "🟠", roleId: "301", label: "Europe" }],
    publishedOptions: [{ emoji: "🟠", roleId: "301", label: "Europe" }],
  };
  assert.equal(await store.savePanel(extra, { token: "current", nowMs: 100 }), true);
  assert.equal((await store.listPanels("100")).length, 2);
  assert.equal((await store.readPanelByMessage("100", "200", "501"))?.id, "regions");
  assert.equal(await store.readPanelByMessage("101", "200", "501"), null);
  await store.releaseLease("100", "current");
  assert.equal(
    await store.savePanel({ ...extra, title: "Stale" }, { token: "current", nowMs: 100 }),
    false,
  );
  assert.equal(await store.claimLease("100", "next", 200), true);
  assert.equal(await store.deletePanel("100", { token: "next", nowMs: 200 }, "regions"), true);
  await store.releaseLease("100", "next");
  assert.equal((await store.readPanel("100"))?.id, "main");
}

function assertSafeTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || !databaseName.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test.");
  }
}
