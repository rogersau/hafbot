import assert from "node:assert/strict";
import test from "node:test";

import { SqliteCommerceBrandingStore } from "./support/sqlite/runtime/commerce/sqlite-branding-store";
import { createTestDatabase } from "./support/sqlite-d1-database";

test("Commerce branding store round-trips audit fields and resets only the matching seller", async () => {
  const database = await createTestDatabase();
  const store = new SqliteCommerceBrandingStore(database.d1);
  const saved = await store.save({
    guildId: "guild-1",
    connectedAccountId: "acct-1",
    accentColor: 0x12abef,
    tagline: "Welcome to the guild",
    actorUserId: "owner-1",
    nowMs: 100,
  });
  assert.deepEqual(saved, {
    guildId: "guild-1",
    connectedAccountId: "acct-1",
    accentColor: 0x12abef,
    tagline: "Welcome to the guild",
    createdByUserId: "owner-1",
    updatedByUserId: "owner-1",
    createdAtMs: 100,
    updatedAtMs: 100,
  });

  const updated = await store.save({
    guildId: "guild-1",
    connectedAccountId: "acct-1",
    accentColor: 0xffffff,
    tagline: "Updated",
    actorUserId: "owner-2",
    nowMs: 200,
  });
  assert.equal(updated.createdByUserId, "owner-1");
  assert.equal(updated.updatedByUserId, "owner-2");
  assert.equal((await store.readByGuild("guild-1"))?.tagline, "Updated");

  await store.reset("guild-1", "wrong-account");
  assert.ok(await store.readByGuild("guild-1"));
  await store.reset("guild-1", "acct-1");
  assert.equal(await store.readByGuild("guild-1"), null);

  await assert.rejects(
    () =>
      database.d1
        .prepare(
          `INSERT INTO commerce_store_branding
            (guild_id, connected_account_id, accent_color, tagline,
             created_by_user_id, updated_by_user_id, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("guild-2", "acct-2", 0x1000000, "bad", "owner", "owner", 1, 1)
        .run(),
    /CHECK constraint failed/,
  );
  database.close();
});
