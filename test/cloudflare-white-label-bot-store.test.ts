/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createCloudflareWhiteLabelBotStore } from "../src/runtime/cloudflare-white-label-bot-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("createCloudflareWhiteLabelBotStore upserts and reads White-Label Bot metadata", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWhiteLabelBotStore(database as unknown as D1Database);

  await store.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "bot-user-1",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "white-label/guild-1/token",
    createdAtMs: 100,
    updatedAtMs: 100,
  });

  assert.deepEqual(await store.readWhiteLabelBot("guild-1"), {
    guildId: "guild-1",
    applicationId: "app-1",
    botUserId: "bot-user-1",
    displayName: "Guild Helper",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "white-label/guild-1/token",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
});

test("createCloudflareWhiteLabelBotStore lists only active White-Label Bots for gateway startup", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWhiteLabelBotStore(database as unknown as D1Database);
  await database
    .prepare(
      "INSERT INTO billing_customer_bindings(owner_id, stripe_customer_id, created_at_ms) VALUES (?, ?, ?)",
    )
    .bind("owner", "cus", 1)
    .run();
  await database
    .prepare(
      `INSERT INTO billing_subscriptions(owner_id, stripe_customer_id, stripe_subscription_id, plan, status, cancel_at_period_end, observed_at_ms)
       VALUES (?, ?, ?, 'premium_plus', 'active', 0, ?)`,
    )
    .bind("owner", "cus", "sub", 1)
    .run();
  await database
    .prepare(
      "INSERT INTO billing_guild_assignments(guild_id, owner_id, stripe_subscription_id, assigned_at_ms) VALUES (?, ?, ?, ?)",
    )
    .bind("guild-active", "owner", "sub", 1)
    .run();

  await store.upsertWhiteLabelBot({
    guildId: "guild-active",
    applicationId: "app-active",
    botUserId: "bot-active",
    displayName: "Active Bot",
    brandFooterText: null,
    status: "active",
    tokenSecretRef: "WHITE_LABEL_BOT_ACTIVE_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  await store.upsertWhiteLabelBot({
    guildId: "guild-pending",
    applicationId: "app-pending",
    botUserId: "bot-pending",
    displayName: "Pending Bot",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "WHITE_LABEL_BOT_PENDING_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  await store.upsertWhiteLabelBot({
    guildId: "guild-suspended",
    applicationId: "app-suspended",
    botUserId: "bot-suspended",
    displayName: "Suspended Bot",
    brandFooterText: null,
    status: "suspended",
    tokenSecretRef: "WHITE_LABEL_BOT_SUSPENDED_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });
  await store.upsertWhiteLabelBot({
    guildId: "guild-decommissioned",
    applicationId: "app-decommissioned",
    botUserId: "bot-decommissioned",
    displayName: "Decommissioned Bot",
    brandFooterText: null,
    status: "decommissioned",
    tokenSecretRef: "WHITE_LABEL_BOT_DECOMMISSIONED_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 100,
  });

  assert.deepEqual(
    (await store.listActiveWhiteLabelBots()).map((bot) => bot.guildId),
    ["guild-active"],
  );
});

test("createCloudflareWhiteLabelBotStore preserves decommissioned records when a replacement is stored", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareWhiteLabelBotStore(database as unknown as D1Database);

  await store.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-old",
    botUserId: "bot-old",
    displayName: "Old Bot",
    brandFooterText: null,
    status: "decommissioned",
    tokenSecretRef: "OLD_TOKEN",
    createdAtMs: 100,
    updatedAtMs: 200,
  });
  await store.upsertWhiteLabelBot({
    guildId: "guild-1",
    applicationId: "app-new",
    botUserId: "bot-new",
    displayName: "New Bot",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "NEW_TOKEN",
    createdAtMs: 300,
    updatedAtMs: 300,
  });

  assert.deepEqual(await store.readWhiteLabelBot("guild-1"), {
    guildId: "guild-1",
    applicationId: "app-new",
    botUserId: "bot-new",
    displayName: "New Bot",
    brandFooterText: null,
    status: "pending_install",
    tokenSecretRef: "NEW_TOKEN",
    createdAtMs: 300,
    updatedAtMs: 300,
  });
});
