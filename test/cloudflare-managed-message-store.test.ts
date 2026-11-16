/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { ManagedMessage, ManagedMessageDraft } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("managed message store persists Managed Message Draft lifecycle data", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  const draft: ManagedMessageDraft = {
    id: "draft-1",
    guildId: "guild-1",
    internalName: "launch",
    channelId: "channel-1",
    embeds: [{ description: "Latest content", fields: [] }],
    buttons: [{ label: "Launch", url: "https://example.com/launch", emoji: "🚀" }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: true },
    status: "scheduled",
    scheduledAtMs: 2_000,
    failureReason: null,
    attemptCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  await store.upsertDraft(draft);

  assert.deepEqual(await store.readDraftById("guild-1", "draft-1"), draft);
  assert.deepEqual(await store.listDraftsByGuild("guild-1"), [draft]);
  assert.equal(await store.countDraftsByGuild("guild-1"), 1);
});

test("managed message store atomically claims a due Scheduled Publish once", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  await store.upsertDraft({
    id: "draft-1",
    guildId: "guild-1",
    internalName: "launch",
    channelId: "channel-1",
    embeds: [{ description: "Latest content", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "scheduled",
    scheduledAtMs: 1_000,
    failureReason: null,
    attemptCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  });

  const claims = await Promise.all([
    store.claimDueDrafts(2_000, 10),
    store.claimDueDrafts(2_000, 10),
  ]);

  assert.equal(claims.flat().length, 1);
  assert.equal(claims.flat()[0]?.draft.id, "draft-1");
});

test("managed message store persists ordered content and marks canonical deletions Missing", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  const message: ManagedMessage = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [
      {
        title: "Rules",
        description: "First",
        fields: [{ name: "One", value: "Value", inline: false }],
      },
      { description: "Second", fields: [] },
    ],
    buttons: [{ label: "Rules", url: "https://example.com/rules" }],
    announcement: { roleIds: ["role-1"], everyone: true, here: false, notifyOnCreate: true },
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  await store.upsert(message);
  assert.deepEqual(await store.listByGuild("guild-1"), [message]);
  assert.equal(await store.countByGuild("guild-1"), 1);

  const missing = await store.markMissingByCanonicalMessage("guild-1", "channel-1", "discord-1", 3);
  assert.equal(missing?.message.status, "missing");
  assert.equal(missing?.message.updatedAtMs, 3);
  assert.equal(missing?.changed, true);

  const redelivery = await store.markMissingByCanonicalMessage("guild-1", "channel-1", "discord-1");
  assert.equal(redelivery?.message.status, "missing");
  assert.equal(redelivery?.changed, false);

  const claim = await store.claimCanonicalMessageDeleteAudit(
    "guild-1",
    "channel-1",
    "discord-1",
    10,
  );
  assert.equal(claim.status, "claimed");
  assert.equal(
    (await store.claimCanonicalMessageDeleteAudit("guild-1", "channel-1", "discord-1", 11)).status,
    "busy",
  );
  assert.equal(claim.status, "claimed");
  await store.markCanonicalMessageDeleteAuditDelivered(claim.event.eventKey, 10, 12);
  assert.equal(
    (await store.claimCanonicalMessageDeleteAudit("guild-1", "channel-1", "discord-1", 13)).status,
    "delivered",
  );
});

test("managed message store atomically marks only one concurrent canonical deletion", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  await store.upsert({
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [{ description: "Rules", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "published",
    createdAtMs: 1,
    updatedAtMs: 1,
  });

  const results = await Promise.all([
    store.markMissingByCanonicalMessage("guild-1", "channel-1", "discord-1", 2),
    store.markMissingByCanonicalMessage("guild-1", "channel-1", "discord-1", 3),
  ]);

  assert.equal(results.filter((result) => result?.changed).length, 1);
  assert.equal(results.filter((result) => result && !result.changed).length, 1);
  const claims = await Promise.all([
    store.claimCanonicalMessageDeleteAudit("guild-1", "channel-1", "discord-1", 10),
    store.claimCanonicalMessageDeleteAudit("guild-1", "channel-1", "discord-1", 11),
  ]);
  assert.equal(claims.filter((claimResult) => claimResult.status === "claimed").length, 1);
  assert.equal(claims.filter((claimResult) => claimResult.status === "busy").length, 1);
});

test("managed message store deletes entities and media ownership atomically", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  const orphan = "orphan.png";
  const shared = "shared.png";
  await store.registerMediaAsset("guild-1", orphan);
  await store.registerMediaAsset("guild-1", shared);
  const message = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [{ description: "Rules", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "published" as const,
    createdAtMs: 1,
    updatedAtMs: 1,
  } satisfies ManagedMessage;
  await store.upsert(message, [orphan, shared]);
  await store.upsert(
    { ...message, id: "managed-2", internalName: "rules-2", messageId: "discord-2" },
    [shared],
  );

  database.execRaw(`
    CREATE TRIGGER fail_managed_message_media_ref_delete
    BEFORE DELETE ON managed_message_media_refs
    BEGIN
      SELECT RAISE(ABORT, 'media reference delete failed');
    END
  `);
  await assert.rejects(store.delete("guild-1", message.id), /media reference delete failed/);
  assert.ok(await store.readById("guild-1", message.id));
  assert.deepEqual(
    database.query("SELECT filename FROM managed_message_media_refs WHERE owner_id='managed-1'"),
    [{ filename: orphan }, { filename: shared }],
  );

  database.execRaw("DROP TRIGGER fail_managed_message_media_ref_delete");
  assert.deepEqual(await store.delete("guild-1", message.id), [orphan, shared]);
  assert.equal(await store.readById("guild-1", message.id), null);
  assert.deepEqual(
    database.query<{ filename: string; status: string }>(
      "SELECT filename, status FROM managed_message_media_assets ORDER BY filename",
    ),
    [
      { filename: orphan, status: "pending_deletion" },
      { filename: shared, status: "active" },
    ],
  );
  assert.equal(await store.claimMediaAssetDeletion("guild-1", shared), false);
  assert.equal(await store.claimMediaAssetDeletion("guild-1", orphan), true);
});

test("managed message media deletion rechecks references before claiming an orphan", async () => {
  const { createSqliteManagedMessageStore } =
    await import("./support/sqlite/runtime/sqlite-managed-message-store");
  const database = new SqliteD1Database();
  const store = createSqliteManagedMessageStore(database as unknown as D1Database);
  const filename = "race.png";
  await store.registerMediaAsset("guild-1", filename);
  const message = {
    id: "managed-1",
    guildId: "guild-1",
    internalName: "rules",
    channelId: "channel-1",
    messageId: "discord-1",
    embeds: [{ description: "Rules", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    status: "published" as const,
    createdAtMs: 1,
    updatedAtMs: 1,
  } satisfies ManagedMessage;
  await store.upsert(message, [filename]);
  assert.deepEqual(await store.deleteMediaReferences("guild-1", "message", message.id), [filename]);
  await store.upsert(
    { ...message, id: "managed-2", internalName: "rules-2", messageId: "discord-2" },
    [filename],
  );

  assert.deepEqual(await store.listPendingMediaAssets("guild-1"), []);
  assert.equal(await store.claimMediaAssetDeletion("guild-1", filename), false);
  assert.deepEqual(
    database.query<{ filename: string; ownerId: string }>(
      "SELECT filename, owner_id AS ownerId FROM managed_message_media_refs",
    ),
    [{ filename, ownerId: "managed-2" }],
  );
});
