import assert from "node:assert/strict";
import test from "node:test";

import { account, user } from "./support/sqlite/db/auth-schema";
import { createSqliteDiscordAccountStore } from "./support/sqlite/runtime/sqlite-discord-account-store";
import { createD1DrizzleDatabase } from "./support/sqlite/runtime/drizzle-db";
import { createTestDatabase } from "./support/sqlite-d1-database";

test("createSqliteDiscordAccountStore returns null when no Discord account exists", async () => {
  const database = await createTestDatabase();
  try {
    const store = createSqliteDiscordAccountStore(database.d1);
    assert.equal(await store.readDiscordAccessToken("user-1"), null);
  } finally {
    database.close();
  }
});

test("createSqliteDiscordAccountStore returns the latest Discord token for the requested user", async () => {
  const database = await createTestDatabase();
  try {
    const db = createD1DrizzleDatabase(database.d1);
    const createdAt = new Date("2026-05-25T10:00:00.000Z");
    await db
      .insert(user)
      .values(
        ["user-1", "user-2"].map((id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
          discordUserId: `discord-${id}`,
          createdAt,
          updatedAt: createdAt,
        })),
      )
      .run();
    await db
      .insert(account)
      .values(
        [
          { id: "old-discord", userId: "user-1", providerId: "discord", hour: 10 },
          { id: "current-discord", userId: "user-1", providerId: "discord", hour: 12 },
          { id: "google", userId: "user-1", providerId: "google", hour: 13 },
          { id: "other-user", userId: "user-2", providerId: "discord", hour: 14 },
        ].map(({ hour, ...entry }) => ({
          ...entry,
          accountId: entry.id,
          accessToken: `${entry.id}-token`,
          createdAt,
          updatedAt: new Date(`2026-05-25T${hour}:00:00.000Z`),
        })),
      )
      .run();

    const store = createSqliteDiscordAccountStore(database.d1);
    assert.equal(await store.readDiscordAccessToken("user-1"), "current-discord-token");
    assert.equal(await store.readDiscordAccessToken("user-2"), "other-user-token");
    assert.equal(await store.readDiscordAccessToken("missing-user"), null);
  } finally {
    database.close();
  }
});
